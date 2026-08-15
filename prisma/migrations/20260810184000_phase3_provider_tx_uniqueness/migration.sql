-- CreateIndex
CREATE UNIQUE INDEX "provider_transactions_provider_provider_transaction_id_key" ON "provider_transactions"("provider", "provider_transaction_id");
