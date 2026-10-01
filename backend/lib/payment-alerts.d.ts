export type PaymentAlertInput = {
  walletId: string;
  userId: string;
  address: string;
  externalId: string;
  amount: number;
  receivedAt: string;
};

export function enqueuePaymentAlert(alert: PaymentAlertInput): Promise<boolean>;
export function drainPaymentAlerts(): Promise<number>;
