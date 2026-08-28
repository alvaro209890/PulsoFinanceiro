/**
 * Autenticação Machine-to-Machine para Agentes (Hermes) — docs/14 §Autenticação.
 *
 * Princípios:
 * - Token bruto nunca fica no banco; somente hash SHA-256;
 * - Validação em tempo constante (timingSafeEqual);
 * - Escopos granulares (metrics:read, events:read, events:claim, events:ack);
 * - Isolamento por principal no SQLite (service_principals).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';

export interface AuthenticatedPrincipal {
  id: string;
  name: string;
  scopes: string[];
}

export class AgentAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

export function verifyTokenHash(givenToken: string, storedHash: string): boolean {
  const givenHash = hashToken(givenToken);
  if (givenHash.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(givenHash, 'utf8'), Buffer.from(storedHash, 'utf8'));
}

export function authenticateAgent(
  db: Db,
  requiredScope: string
): (req: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedPrincipal> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedPrincipal> => {
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      reply.code(401).send({
        error: {
          code: 'SERVICE_TOKEN_INVALID',
          message: 'Header Authorization Bearer obrigatório para rotas de agente.',
          timestamp: new Date().toISOString(),
        },
      });
      throw new AgentAuthError(401, 'SERVICE_TOKEN_INVALID', 'Token ausente');
    }

    const token = authHeader.slice(7).trim();
    const rows = db
      .prepare(
        `SELECT id, name, current_token_hash, next_token_hash, scopes_json, active
           FROM service_principals
          WHERE active = 1`
      )
      .all() as Array<{
      id: string;
      name: string;
      current_token_hash: string;
      next_token_hash: string | null;
      scopes_json: string;
      active: number;
    }>;

    let matchedPrincipal: AuthenticatedPrincipal | null = null;

    for (const r of rows) {
      const matchCurrent = verifyTokenHash(token, r.current_token_hash);
      const matchNext = r.next_token_hash ? verifyTokenHash(token, r.next_token_hash) : false;

      if (matchCurrent || matchNext) {
        let scopes: string[] = [];
        try {
          scopes = JSON.parse(r.scopes_json) as string[];
        } catch {
          scopes = [];
        }
        matchedPrincipal = {
          id: r.id,
          name: r.name,
          scopes,
        };
        break;
      }
    }

    if (!matchedPrincipal) {
      reply.code(401).send({
        error: {
          code: 'SERVICE_TOKEN_INVALID',
          message: 'Token de serviço inválido ou revogado.',
          timestamp: new Date().toISOString(),
        },
      });
      throw new AgentAuthError(401, 'SERVICE_TOKEN_INVALID', 'Token inválido');
    }

    if (!matchedPrincipal.scopes.includes(requiredScope)) {
      reply.code(403).send({
        error: {
          code: 'SCOPE_DENIED',
          message: `Escopo '${requiredScope}' negado para o principal '${matchedPrincipal.name}'.`,
          timestamp: new Date().toISOString(),
        },
      });
      throw new AgentAuthError(403, 'SCOPE_DENIED', 'Escopo negado');
    }

    return matchedPrincipal;
  };
}
