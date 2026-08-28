import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeTextForAI, sanitizeObjectForAI } from '../src/ai/sanitize.js';
import { buildServer } from '../src/index.js';
import { executeAIAction } from '../src/ai/actions.js';
import * as client from '../src/ai/client.js';

describe('Camada de IA F5 (docs/10-camada-ia.md)', () => {
  describe('Sanitização Fail-Closed de PII', () => {
    it('remove CPF, cartão, e-mail, telefone e segredos de strings', () => {
      const dirty = 'Cliente CPF 123.456.789-00 pagou no cartao 4111 2222 3333 4444 email alvaro@teste.com sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
      const clean = sanitizeTextForAI(dirty);

      expect(clean).not.toContain('123.456.789-00');
      expect(clean).not.toContain('4111 2222 3333 4444');
      expect(clean).not.toContain('alvaro@teste.com');
      expect(clean).not.toContain('sk-ant-api03');
      expect(clean).toContain('[CPF_REMOVIDO]');
      expect(clean).toContain('[CARTAO_REMOVIDO]');
      expect(clean).toContain('[EMAIL_REMOVIDO]');
      expect(clean).toContain('[SEGREDO_REMOVIDO]');
    });

    it('sanitiza recursivamente campos sensíveis em objetos e arrays', () => {
      const payload = {
        password: 'minhasenhasecreta',
        cardNumber: '1234567890123456',
        description: 'Pix enviado para 123.456.789-00',
        nested: {
          items: ['comentário com sk-12345678901234567890123456'],
        },
      };

      const cleaned = sanitizeObjectForAI(payload);
      expect((cleaned as any).password).toBeUndefined();
      expect((cleaned as any).cardNumber).toBeUndefined();
      expect(cleaned.description).toContain('[CPF_REMOVIDO]');
      expect(cleaned.nested.items[0]).toContain('[SEGREDO_REMOVIDO]');
    });
  });

  describe('Execução de Ações com Mock de IA', () => {
    let server: ReturnType<typeof buildServer>;

    beforeEach(() => {
      process.env.PLUGGY_CLIENT_ID = 'test-id';
      process.env.PLUGGY_CLIENT_SECRET = 'test-secret';
      server = buildServer(':memory:');
      const db = server.db;

      db.prepare('INSERT INTO items (public_id, external_id, status) VALUES (?,?,?)').run(
        'item-1',
        'ext-item-1',
        'UPDATED'
      );
      db.prepare(
        `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance, currency)
         VALUES ('acc-bank','ext-acc-bank','item-1','BANK',NULL,'Conta corrente',1000,'BRL')`
      ).run();
      db.prepare(
        `INSERT INTO categories (id, description, description_translated, level1_prefix)
         VALUES ('08000000','Compras','Compras','08')`
      ).run();
      db.prepare(
        `INSERT INTO transactions
           (public_id, external_id, account_public_id, amount, currency, date, status, type,
            category_id, is_internal_transfer, raw_json_sanitized)
         VALUES ('tx_1','ext_1','acc-bank',120.5,'BRL','2026-08-10','POSTED','DEBIT','08000000',0,'{}')`
      ).run();
    });

    afterEach(async () => {
      await server.close();
    });

    it('MONTHLY_NARRATIVE constrói contexto sanitizado e devolve metricRefs válidas', async () => {
      const mockResponse = {
        content: JSON.stringify({
          title: 'Resumo de Agosto',
          summary: 'Gasto total controlado.',
          changes: ['Aumento em alimentação.'],
          alerts: [],
        }),
        model: 'ag/gemini-3.7-flash-high',
      };

      vi.spyOn(client, 'callAI').mockResolvedValueOnce(mockResponse);

      const res = await executeAIAction(server.db, {
        action: 'MONTHLY_NARRATIVE',
        period: '2026-08',
      });

      expect(res.action).toBe('MONTHLY_NARRATIVE');
      expect(res.freshnessStatus).toBe('FRESH');
      expect(res.result.title).toBe('Resumo de Agosto');
      expect(res.metricRefs.length).toBeGreaterThan(0);
    });

    it('COMMENT_FORECAST devolve análise de projeção', async () => {
      const mockResponse = {
        content: JSON.stringify({
          title: 'Projeção Estável',
          body: 'Ritmo consistente com os dias anteriores.',
        }),
        model: 'ag/gemini-3.7-flash-high',
      };

      vi.spyOn(client, 'callAI').mockResolvedValueOnce(mockResponse);

      const res = await executeAIAction(server.db, {
        action: 'COMMENT_FORECAST',
        period: '2026-08',
      });

      expect(res.action).toBe('COMMENT_FORECAST');
      expect(res.result.title).toBe('Projeção Estável');
    });

    it('SUGGEST_CATEGORY devolve recomendação baseada nos candidatos locais', async () => {
      const mockResponse = {
        content: JSON.stringify({
          transactionId: 'tx_1',
          suggestedCategoryId: '08000000',
          categoryName: 'Compras',
          confidence: 0.95,
          reason: 'Identificado padrão de compras na descrição.',
        }),
        model: 'ag/gemini-3.7-flash-high',
      };

      vi.spyOn(client, 'callAI').mockResolvedValueOnce(mockResponse);

      const res = await executeAIAction(server.db, {
        action: 'SUGGEST_CATEGORY',
        targetRef: 'tx_1',
      });

      expect(res.action).toBe('SUGGEST_CATEGORY');
      expect(res.result.categoryName).toBe('Compras');
    });
  });
});
