-- Japanese names and comments: MySQL takes them in identifiers and strings,
-- and DBdialog reads, draws and rewrites them like any other.
CREATE TABLE 作家 (
  ID   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '作家の番号',
  名前 VARCHAR(100) NOT NULL COMMENT '筆名',
  PRIMARY KEY (ID)
) COMMENT='作家';

CREATE TABLE 作品 (
  ID     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  作家ID BIGINT UNSIGNED NOT NULL COMMENT '書いた作家',
  題名   VARCHAR(200) NOT NULL,
  状態   VARCHAR(3) NOT NULL DEFAULT '執筆中' COMMENT '書き上がったか',
  PRIMARY KEY (ID),
  UNIQUE KEY (作家ID, 題名),
  CHECK (状態 IN ('執筆中', '完成', '絶版')),
  FOREIGN KEY (作家ID) REFERENCES 作家 (ID)
) COMMENT='作品';

CREATE TABLE 章 (
  作品ID BIGINT UNSIGNED NOT NULL,
  章番号 INT UNSIGNED NOT NULL,
  見出し VARCHAR(200) NOT NULL,
  PRIMARY KEY (作品ID, 章番号),
  FOREIGN KEY (作品ID) REFERENCES 作品 (ID) ON DELETE CASCADE
) COMMENT='作品の章';
