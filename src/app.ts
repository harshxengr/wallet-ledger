import express from "express";
import { z } from "zod";
import { prisma } from "./db";
import { createHash } from "node:crypto";
import {
    transferMoney,
    InsufficientFundsError,
    AccountNotFoundError,
    IdempotencyKeyReuseError
} from "./transfer";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
    res.json({
        status: "ok"
    })
})

const createWalletSchema = z.object({
    userId: z.string().uuid()
})

const transferSchema = z.object({
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
    .refine((d) => d.fromAccountId !== d.toAccountId, {
        message: "cannot transfer to the same account",
        path: ["toAccountId"]
    })

const idempotencyKeySchema = z.string().min(8).max(100);

const idParamSchema = z.object({
    id: z.string().uuid()
})

const serializeAccount = (a: {
    id: string;
    userId: string;
    currency: string;
    balanceMinor: bigint;
    createdAt: Date;
}) => ({
    id: a.id,
    userId: a.userId,
    currency: a.currency,
    balanceMinor: a.balanceMinor.toString(),
    createdAt: a.createdAt.toISOString(),
})

const serializeTransfer = (t: {
    id: string;
    fromAccountId: string;
    toAccountId: string;
    amountMinor: bigint;
    status: string;
    createdAt: Date;
}) => ({
    id: t.id,
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amountMinor: t.amountMinor.toString(),
    status: t.status,
    createdAt: t.createdAt.toISOString(),
});

const validationError = (res: express.Response, issues: unknown) => {
    res.status(400).json({
        error: {
            code: "validation_error",
            issues
        }
    });
}

app.post("/api/v1/wallets", async (req, res) => {
    const parsed = createWalletSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const account = await prisma.account.create({
        data: {
            userId: parsed.data.userId
        }
    })

    return res.status(201).json(serializeAccount(account));
})

app.get("/api/v1/wallets/:id", async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const account = await prisma.account.findUnique({
        where: { id: parsed.data.id }
    })

    if (!account) {
        return res
            .status(404)
            .json({
                error: {
                    code: "wallet_not_found",
                    message: "wallet not found"
                }
            })
    }

    return res.json(serializeAccount(account))
})

app.post("/api/v1/transfers", async (req, res) => {

    const keyParsed = idempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
    if (!keyParsed.success) {
        return res.status(400).json({
            error: {
                code: "idempotency_key_required",
                message: "Idempotency-Key header (8 to 100 characters) is required",
            },
        });
    }

    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const { fromAccountId, toAccountId, amountMinor } = parsed.data;

    const requestHash = createHash("sha256")
        .update(JSON.stringify({ fromAccountId, toAccountId, amountMinor }))
        .digest("hex");

    try {
        const { transfer, replayed } = await transferMoney(
            fromAccountId,
            toAccountId,
            BigInt(amountMinor),
            { key: keyParsed.data, requestHash }
        );

        if (replayed) res.setHeader("Idempotent-Replay", "true");

        return res.status(201).json(serializeTransfer(transfer));
    } catch (err) {
        if (err instanceof InsufficientFundsError) {
            return res.status(422).json({
                error: {
                    code: "insufficient_funds",
                    message: "insufficient funds"
                },
            });
        }

        if (err instanceof AccountNotFoundError) {
            return res.status(404).json({
                error: {
                    code: "wallet_not_found",
                    message: "wallet not found"
                },
            });
        }

        if (err instanceof IdempotencyKeyReuseError) {
            return res.status(422).json({
                error: {
                    code: "idempotency_key_reuse",
                    message: "this Idempotency-Key was already used with a different request",
                },
            });
        }

        console.error(err);

        return res.status(500).json({
            error: {
                code: "internal_error",
                message: "something went wrong"
            },
        });
    }
})