-- Relationships the other fixtures do not have: identifying ones (the foreign
-- key is part of the child's primary key), a child with one row at most, a
-- primary key in another order than the columns, and a table without one.

CREATE TABLE customers (
  id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY (code)
);

CREATE TABLE orders (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NULL,
  ordered_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE order_items (
  line_no  INT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  PRIMARY KEY (order_id, line_no),
  FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE order_notes (
  order_id BIGINT UNSIGNED NOT NULL,
  note     TEXT NOT NULL,
  PRIMARY KEY (order_id),
  FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE logs (
  message    VARCHAR(100) NULL,
  created_at DATETIME NOT NULL
);
