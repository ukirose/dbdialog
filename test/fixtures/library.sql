CREATE TABLE tenants (
  ID   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (ID)
);

CREATE TABLE members (
  ID        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(100) NOT NULL,
  PRIMARY KEY (ID),
  UNIQUE KEY (tenant_id, ID),
  FOREIGN KEY (tenant_id) REFERENCES tenants (ID)
);

CREATE TABLE delivery_methods (
  ID        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(50) NOT NULL,
  kind      VARCHAR(10) NOT NULL,
  PRIMARY KEY (ID),
  UNIQUE KEY (tenant_id, ID, kind),
  CHECK (kind IN ('mail', 'counter', 'locker')),
  FOREIGN KEY (tenant_id) REFERENCES tenants (ID)
);

CREATE TABLE member_addresses (
  ID        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  address   VARCHAR(100) NOT NULL,
  PRIMARY KEY (ID),
  UNIQUE KEY (tenant_id, member_id, ID),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, ID)
);

CREATE TABLE loans (
  ID                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  number             INT UNSIGNED NOT NULL,
  member_id          BIGINT UNSIGNED NOT NULL,
  delivery_method_id BIGINT UNSIGNED NULL,
  delivery_kind      VARCHAR(10) NULL,
  address_id         BIGINT UNSIGNED NULL,
  fee                DECIMAL(15,0) NULL,
  status             VARCHAR(6) NOT NULL DEFAULT 'new',
  PRIMARY KEY (ID),
  UNIQUE KEY (tenant_id, number),
  UNIQUE KEY (tenant_id, ID),
  CHECK (status IN ('new', 'active', 'closed')),
  CHECK (fee > 0),
  CHECK ((delivery_method_id IS NULL) = (delivery_kind IS NULL)),
  CHECK (address_id IS NULL OR delivery_kind = 'mail'),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, ID),
  FOREIGN KEY (tenant_id, delivery_method_id, delivery_kind) REFERENCES delivery_methods (tenant_id, ID, kind),
  FOREIGN KEY (tenant_id, member_id, address_id) REFERENCES member_addresses (tenant_id, member_id, ID)
);

CREATE TABLE loan_files (
  ID        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  loan_id   BIGINT UNSIGNED NOT NULL,
  s3_key    VARCHAR(1024) NOT NULL,
  PRIMARY KEY (ID),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES loans (tenant_id, ID) ON DELETE CASCADE
);

CREATE TABLE member_codes (
  ID         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  code       VARCHAR(20) NOT NULL,
  deleted_at DATETIME NULL,
  alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (ID),
  UNIQUE KEY (tenant_id, code, alive)
);
