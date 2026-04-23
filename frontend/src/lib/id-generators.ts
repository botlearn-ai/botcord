import { randomBytes } from "crypto";

export const generateHumanId = () => "hu_" + randomBytes(6).toString("hex");

export const generateShareId = () => "sh_" + randomBytes(6).toString("hex");
export const generateTxId = () => "tx_" + randomBytes(8).toString("hex");
export const generateWalletEntryId = () => "we_" + randomBytes(8).toString("hex");
export const generateTopupId = () => "tu_" + randomBytes(8).toString("hex");
export const generateWithdrawalId = () => "wd_" + randomBytes(8).toString("hex");
export const generateSubscriptionProductId = () => "sp_" + randomBytes(8).toString("hex");
export const generateSubscriptionId = () => "sub_" + randomBytes(8).toString("hex");
export const generateChargeAttemptId = () => "sca_" + randomBytes(8).toString("hex");
