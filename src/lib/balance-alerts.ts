import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const balanceAlertSchema = z.object({
  address: z.string().regex(/^G[A-Z2-7]{55}$/),
  amount: z.number().finite().positive(),
  availableBalance: z.number().finite().nonnegative(),
  receivedAt: z.string().datetime(),
});

export const sendBalanceAlert = createServerFn({ method: "POST" })
  .validator(balanceAlertSchema)
  .handler(async ({ data }) => {
    const { sendBalanceAlert: send } = await import("../../server/balance-alerts");
    await send(data);
  });
