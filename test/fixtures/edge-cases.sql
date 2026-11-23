# Edge cases for the parser: formatting, comments, quoting, statements it does not draw
delimiter //
create trigger trg_x before insert on other for each row begin set new.id = 1; end//
delimiter ;

create table if not exists `my table` (
  `id` int not null auto_increment primary key comment 'it''s a "key" \\ path',
  `order` int null default -1,   -- a reserved word as a column name
  note text,
  ref_id int references other (id) on delete cascade,  -- MySQL 8.0 ignores this
  email varchar(255) character set utf8mb4 collate utf8mb4_bin not null unique,
  kind enum('a','b') not null default 'a',
  updated_at timestamp(3) null default current_timestamp(3) on update current_timestamp(3),
  /* a block comment inside the body */
  amount decimal(10, 2) not null check (amount >= 0),
  key idx_note (note(20)),
  index ((lower(email))),
  constraint chk_kind check (kind in ('a', 'b')) not enforced
) engine = InnoDB, comment "double-quoted comment";

CREATE TABLE other (id INT PRIMARY KEY);
CREATE INDEX idx_other ON other (id);
ALTER TABLE other ADD CONSTRAINT fk_o FOREIGN KEY (id) REFERENCES `my table` (id);
CREATE TABLE copy_of_other LIKE other;
CREATE TABLE broken (a INT, b INT NOT NULL DEFAULT, c INT);
CREATE TABLE parts (id INT, d DATE) PARTITION BY RANGE (YEAR(d)) (PARTITION p0 VALUES LESS THAN (2020));
