import { prisma } from './db';

export class InsufficientFundsError extends Error { }
export class AccountNotFoundError extends Error { }
export class IdempotencyKeyReuseError extends Error { }

export async function transferMoney(
    fromId: string,
    toId: string,
    amountMinor: bigint,
    idem: {
        key: string;
        requestHash: string
    }
) {
    if (fromId === toId) throw new Error('Cannot transfer money to the same account');
    if (amountMinor <= 0n) throw new Error('Amount must be greater than zero');

    return prisma.$transaction(async (tx: any) => {
        // first claim key
        const claimed = await tx.$executeRaw`
      INSERT INTO idempotency_keys (scope_id, key, request_hash)
      VALUES (${fromId}::uuid, ${idem.key}, ${idem.requestHash})
      ON CONFLICT (scope_id, key) DO NOTHING`;

        if (claimed === 0) {
            // The key already exists: return the old result
            const existing = await tx.idempotencyKey.findUnique({
                where: {
                    scopeId_key: {
                        scopeId: fromId,
                        key: idem.key
                    }
                },
                include: { transfer: true },
            });

            if (!existing || !existing.transfer) {
                throw new Error("idempotency record incomplete");
            }

            if (existing.requestHash !== idem.requestHash) {
                throw new IdempotencyKeyReuseError();
            }

            return {
                transfer: existing.transfer,
                replayed: true
            };
        }

        // Lock both wallets, always in the same order
        const [first, second] = [fromId, toId].sort();
        const rows = await tx.$queryRaw<{ id: string, balance_minor: bigint }[]>`
            SELECT id, balance_minor FROM accounts
            WHERE id IN (${first}::uuid, ${second}::uuid)
            ORDER BY id
            FOR UPDATE
        `;

        if (rows.length !== 2) throw new AccountNotFoundError();

        // balance check
        const from = rows.find((r: { id: string }) => r.id === fromId)!;
        if (from.balance_minor < amountMinor) throw new InsufficientFundsError();

        // balance update
        await tx.account.update({
            where: { id: fromId },
            data: { balanceMinor: { decrement: amountMinor } }
        });

        await tx.account.update({
            where: { id: toId },
            data: { balanceMinor: { increment: amountMinor } }
        });

        // transfer and two rows of the ledger
        const transfer = await tx.transfer.create({
            data: { fromAccountId: fromId, toAccountId: toId, amountMinor, status: "completed" }
        })

        await tx.ledgerEntry.createMany({
            data: [
                { transferId: transfer.id, accountId: fromId, direction: "debit", amountMinor },
                { transferId: transfer.id, accountId: toId, direction: "credit", amountMinor },
            ]
        })

        // Connect the key to the transfer
        await tx.idempotencyKey.update({
            where: { scopeId_key: { scopeId: fromId, key: idem.key } },
            data: { transferId: transfer.id },
        });

        return { transfer, replayed: false };
    })
}