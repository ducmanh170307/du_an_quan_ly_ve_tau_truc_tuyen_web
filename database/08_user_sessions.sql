-- FILE 8: TAO BANG PHIEN DANG NHAP
-- Chay sau 07_users.sql.

USE TrainTicketDB;
GO

IF DB_NAME() <> N'TrainTicketDB'
BEGIN
    THROW 50001, N'Hãy chạy file này trong TrainTicketDB.', 1;
END;

IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
BEGIN
    THROW 50002, N'Hãy chạy 07_users.sql trước khi tạo bảng phiên.', 1;
END;

-- 1. Luu ban bam SHA-256 cua ma phien va han su dung theo UTC.
IF OBJECT_ID(N'dbo.UserSessions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserSessions (
        token_hash BINARY(32) NOT NULL
            CONSTRAINT PK_UserSessions PRIMARY KEY,
        user_id INT NOT NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_UserSessions_CreatedAt DEFAULT (SYSUTCDATETIME()),
        expires_at DATETIME2 NOT NULL,

        CONSTRAINT FK_UserSessions_Users
            FOREIGN KEY (user_id) REFERENCES dbo.Users(id),
        CONSTRAINT CK_UserSessions_Expiration
            CHECK (expires_at > created_at)
    );
END;

-- 2. Tao chi muc de tra theo tai khoan va tim phien het han.
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.UserSessions', N'U')
      AND name = N'IX_UserSessions_UserId'
)
BEGIN
    CREATE INDEX IX_UserSessions_UserId ON dbo.UserSessions (user_id);
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.UserSessions', N'U')
      AND name = N'IX_UserSessions_ExpiresAt'
)
BEGIN
    CREATE INDEX IX_UserSessions_ExpiresAt ON dbo.UserSessions (expires_at);
END;

-- 3. Kiem tra bang sau khi tao.
SELECT COUNT(*) AS total_sessions
FROM dbo.UserSessions;
GO