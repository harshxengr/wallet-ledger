import { randomUUID } from "node:crypto";
import { transferMoney } from "../transfer";
import { prisma } from "../db";

async function main() {
    const rahul = await prisma.account.create({
        data: { userId: randomUUID(), balanceMinor: 100000n }, // ₹1000
    });
    const priya = await prisma.account.create({
        data: { userId: randomUUID(), balanceMinor: 0n },
    });

    await transferMoney(rahul.id, priya.id, 50000n); // ₹500

    const accounts = await prisma.account.findMany({
        where: { id: { in: [rahul.id, priya.id] } },
    });
    console.log(accounts);
    console.log("ledger rows:", await prisma.ledgerEntry.count());

    try {
        await transferMoney(rahul.id, priya.id, 99999999n);
    } catch (e) {
        console.log("blocked:", (e as Error).constructor.name);
    }

    console.log("ledger rows after failed try:", await prisma.ledgerEntry.count());
}

main().finally(() => prisma.$disconnect());