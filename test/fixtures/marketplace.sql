-- A marketplace: purchases from sellers, under categories, sent in shipments.
-- A purchase and its latest shipment refer to each other (a cycle): checks are off while creating.
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE tenants (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Tenant ID',
  name       VARCHAR(100)    NOT NULL COMMENT 'Store name',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created at',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Tenants (the stores on the marketplace)';

CREATE TABLE sellers (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Seller ID',
  tenant_id  BIGINT UNSIGNED NOT NULL COMMENT 'Tenant ID',
  code       VARCHAR(20)     NOT NULL COMMENT 'Seller code',
  name       VARCHAR(100)    NOT NULL COMMENT 'Seller name',
  deleted_at DATETIME        NULL COMMENT 'When the seller was deleted (soft delete)',
  alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED COMMENT '1 while active, NULL once deleted',
  PRIMARY KEY (id),
  UNIQUE KEY uq_sellers_tenant_id (tenant_id, id),
  UNIQUE KEY uq_sellers_code (tenant_id, code, alive),
  CONSTRAINT fk_sellers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Sellers';

CREATE TABLE categories (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Category ID',
  tenant_id BIGINT UNSIGNED NOT NULL COMMENT 'Tenant ID',
  parent_id BIGINT UNSIGNED NULL COMMENT 'Parent category (for totals)',
  name      VARCHAR(50)     NOT NULL COMMENT 'Category name',
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_tenant_id (tenant_id, id),
  -- Refers to its own table: the parent is in the same tenant
  CONSTRAINT fk_categories_parent FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  CONSTRAINT fk_categories_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Categories';

CREATE TABLE purchases (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Purchase ID',
  tenant_id           BIGINT UNSIGNED NOT NULL COMMENT 'Tenant ID',
  number              INT UNSIGNED    NOT NULL COMMENT 'Purchase number, unique within the tenant',
  seller_id           BIGINT UNSIGNED NOT NULL COMMENT 'Seller ID',
  amount              DECIMAL(15,0)   NULL COMMENT 'Amount paid',
  tax_amount          DECIMAL(15,0)   NULL COMMENT 'Of which tax',
  amount_excl_tax     DECIMAL(15,0)   AS (amount - tax_amount) VIRTUAL COMMENT 'Amount without tax',
  status              VARCHAR(6)      NOT NULL DEFAULT 'new' COMMENT 'Status',
  current_shipment_id BIGINT UNSIGNED NULL COMMENT 'Latest shipment ID',
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchases_number (tenant_id, number),
  UNIQUE KEY uq_purchases_tenant_id (tenant_id, id),
  CONSTRAINT chk_purchases_status CHECK (status IN ('new', 'active', 'closed')),
  CONSTRAINT chk_purchases_amount CHECK (amount > 0),
  CHECK (tax_amount IS NULL OR tax_amount <= amount),
  CONSTRAINT fk_purchases_seller FOREIGN KEY (tenant_id, seller_id) REFERENCES sellers (tenant_id, id),
  CONSTRAINT fk_purchases_shipment FOREIGN KEY (tenant_id, current_shipment_id) REFERENCES shipments (tenant_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Purchases';

CREATE TABLE shipments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Shipment ID',
  tenant_id   BIGINT UNSIGNED NOT NULL COMMENT 'Tenant ID',
  purchase_id BIGINT UNSIGNED NOT NULL COMMENT 'Purchase it sends',
  PRIMARY KEY (id),
  UNIQUE KEY uq_shipments_tenant_id (tenant_id, id),
  /* A purchase and its shipments refer to each other (a cycle) */
  CONSTRAINT fk_shipments_purchase FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases (tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Shipments';

CREATE TABLE purchase_files (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'File ID',
  tenant_id   BIGINT UNSIGNED NOT NULL COMMENT 'Tenant ID',
  purchase_id BIGINT UNSIGNED NOT NULL COMMENT 'Purchase ID',
  s3_key      VARCHAR(1024)   NOT NULL COMMENT 'S3 object key',
  sort_order  INT UNSIGNED    NOT NULL DEFAULT 1 COMMENT 'Display order',
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_files_order (tenant_id, purchase_id, sort_order),
  CONSTRAINT fk_purchase_files_purchase FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases (tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Files of a purchase (receipts, photos; several per purchase)';

SET FOREIGN_KEY_CHECKS = 1;
