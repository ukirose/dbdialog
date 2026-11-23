-- Signs of SQL antipatterns, planted for the tests of lint and the agent view:
-- purchases.total and products.price are FLOAT money; refunds → purchases leaves out
-- tenant_id, which the other keys carry; comments.commentable_id (with a type column)
-- and orders.customer_id have no foreign key; products.tag1..tag3 are numbered.

CREATE TABLE tenants (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL);
CREATE TABLE customers (
  id INT PRIMARY KEY, tenant_id INT NOT NULL, name VARCHAR(50) NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id)
);
CREATE TABLE purchases (
  id INT PRIMARY KEY, tenant_id INT NOT NULL, customer_id INT NOT NULL, total FLOAT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE TABLE purchase_lines (
  tenant_id INT NOT NULL, purchase_id INT NOT NULL, line_no INT NOT NULL, amount DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (tenant_id, purchase_id, line_no),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases (tenant_id, id)
);
CREATE TABLE refunds (
  id INT PRIMARY KEY, tenant_id INT NOT NULL, purchase_id INT NOT NULL, refunded_at DATETIME NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  FOREIGN KEY (purchase_id) REFERENCES purchases (id)
);
CREATE TABLE comments (
  id INT PRIMARY KEY, tenant_id INT NOT NULL, commentable_type VARCHAR(20) NOT NULL, commentable_id INT NOT NULL, body TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants (id)
);
CREATE TABLE products (
  id INT PRIMARY KEY, tenant_id INT NOT NULL, price FLOAT, tag1 VARCHAR(20), tag2 VARCHAR(20), tag3 VARCHAR(20),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id)
);
CREATE TABLE orders (
  id INT PRIMARY KEY, tenant_id INT NOT NULL, customer_id INT NOT NULL, product_id INT NOT NULL,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
