CREATE TABLE `User` (
  `id` INT NOT NULL PRIMARY KEY,
  `name` VARCHAR(191) NOT NULL
);

CREATE TABLE `Post` (
  `id` INT NOT NULL PRIMARY KEY,
  `title` VARCHAR(191) NOT NULL,
  `authorId` INT NOT NULL,
  INDEX `Post_authorId_idx` (`authorId`),
  CONSTRAINT `Post_authorId_fkey`
    FOREIGN KEY (`authorId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);
