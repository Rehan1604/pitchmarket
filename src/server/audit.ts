import { db, schema, type DbOrTx } from "@/db";

export type AuditActor = "user" | "system" | "admin";

export async function audit(
  entry: {
    userId?: string | null;
    actor: AuditActor;
    action: string;
    entityType?: string;
    entityId?: string | number;
    metadata?: Record<string, unknown>;
  },
  tx: DbOrTx = db,
) {
  await tx.insert(schema.auditEvents).values({
    userId: entry.userId ?? null,
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId === undefined ? null : String(entry.entityId),
    metadata: entry.metadata ?? null,
  });
}
