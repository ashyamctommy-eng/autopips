-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'ADMIN', 'TRADING_MANAGER');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ADDITIONAL_INFO_REQUIRED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'WAITING', 'CONFIRMED', 'SENDING', 'FINISHED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'MATURED', 'CANCELLED', 'CLOSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "twoFactorSecret" TEXT,
    "is2FAEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "dob" TIMESTAMP(3) NOT NULL,
    "address" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "idFrontKey" TEXT NOT NULL,
    "idBackKey" TEXT,
    "proofOfAddressKey" TEXT NOT NULL,
    "selfieKey" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "minInvestment" DECIMAL(18,2) NOT NULL,
    "maxInvestment" DECIMAL(18,2) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "targetReturnMin" DECIMAL(18,2) NOT NULL,
    "targetReturnMax" DECIMAL(18,2) NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "performanceFee" DECIMAL(18,2) NOT NULL,
    "managementFee" DECIMAL(18,2) NOT NULL,
    "maxDrawdown" DECIMAL(18,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "capitalUsd" DECIMAL(18,2) NOT NULL,
    "currentValUsd" DECIMAL(18,2) NOT NULL,
    "realizedPnL" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "unrealizedPnL" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "feesDeducted" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "status" "InvestmentStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3),
    "maturityDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Investment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountUsd" DECIMAL(18,2) NOT NULL,
    "cryptoCurrency" VARCHAR(32) NOT NULL,
    "paymentId" TEXT NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "payAmount" DECIMAL(18,8) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "ipnPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountUsd" DECIMAL(18,2) NOT NULL,
    "cryptoCurrency" VARCHAR(32) NOT NULL,
    "payoutAddress" TEXT NOT NULL,
    "feeUsd" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerConnection" (
    "id" TEXT NOT NULL,
    "metaApiAccountId" TEXT NOT NULL,
    "brokerName" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "maskedAccount" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "freeMargin" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeRecord" (
    "id" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "metaApiPositionId" TEXT,
    "instrument" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "volume" DECIMAL(18,5) NOT NULL,
    "entryPrice" DECIMAL(18,5) NOT NULL,
    "exitPrice" DECIMAL(18,5),
    "stopLoss" DECIMAL(18,5),
    "takeProfit" DECIMAL(18,5),
    "grossPnL" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "commission" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "swap" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "netPnL" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "status" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "TradeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_kycStatus_idx" ON "User"("kycStatus");

-- CreateIndex
CREATE UNIQUE INDEX "KycProfile_userId_key" ON "KycProfile"("userId");

-- CreateIndex
CREATE INDEX "KycProfile_status_idx" ON "KycProfile"("status");

-- CreateIndex
CREATE INDEX "KycProfile_createdAt_idx" ON "KycProfile"("createdAt");

-- CreateIndex
CREATE INDEX "TradingPlan_isActive_idx" ON "TradingPlan"("isActive");

-- CreateIndex
CREATE INDEX "Investment_userId_idx" ON "Investment"("userId");

-- CreateIndex
CREATE INDEX "Investment_status_idx" ON "Investment"("status");

-- CreateIndex
CREATE INDEX "Investment_planId_idx" ON "Investment"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_paymentId_key" ON "Deposit"("paymentId");

-- CreateIndex
CREATE INDEX "Deposit_userId_idx" ON "Deposit"("userId");

-- CreateIndex
CREATE INDEX "Deposit_status_idx" ON "Deposit"("status");

-- CreateIndex
CREATE INDEX "Withdrawal_userId_idx" ON "Withdrawal"("userId");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerConnection_metaApiAccountId_key" ON "BrokerConnection"("metaApiAccountId");

-- CreateIndex
CREATE INDEX "BrokerConnection_status_idx" ON "BrokerConnection"("status");

-- CreateIndex
CREATE INDEX "TradeRecord_investmentId_idx" ON "TradeRecord"("investmentId");

-- CreateIndex
CREATE INDEX "TradeRecord_status_idx" ON "TradeRecord"("status");

-- CreateIndex
CREATE INDEX "TradeRecord_instrument_idx" ON "TradeRecord"("instrument");

-- CreateIndex
CREATE INDEX "TradeRecord_openedAt_idx" ON "TradeRecord"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeRecord_brokerId_metaApiPositionId_key" ON "TradeRecord"("brokerId", "metaApiPositionId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "KycProfile" ADD CONSTRAINT "KycProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TradingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRecord" ADD CONSTRAINT "TradeRecord_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRecord" ADD CONSTRAINT "TradeRecord_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "BrokerConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

