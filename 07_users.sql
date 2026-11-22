-- FILE 7: TAO BANG TAI KHOAN WEBSITE
-- Tai khoan se duoc tao qua Backend o cac buoc tiep theo.
-- password_hash luu ket qua bam, khong tu dong bam mat khau.

USE TrainTicketDB;
GO

-- 1. Tao bang nguoi dung neu chua ton tai.
IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Users (
        id INT IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_Users PRIMARY KEY,
        full_name NVARCHAR(100) NOT NULL,
        email NVARCHAR(254) COLLATE Latin1_General_100_CI_AS NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NULL,
        [role] VARCHAR(20) NOT NULL
            CONSTRAINT DF_Users_Role DEFAULT ('CUSTOMER'),
        is_active BIT NOT NULL
            CONSTRAINT DF_Users_IsActive DEFAULT (1),
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2 NOT NULL
            CONSTRAINT DF_Users_UpdatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT UQ_Users_Email
            UNIQUE (email),
        CONSTRAINT CK_Users_FullName_NotBlank
            CHECK (LEN(LTRIM(RTRIM(full_name))) > 0),
        CONSTRAINT CK_Users_Email_NotBlank
            CHECK (LEN(LTRIM(RTRIM(email))) > 0),
        CONSTRAINT CK_Users_PasswordHash_NotBlank
            CHECK (LEN(LTRIM(RTRIM(password_hash))) > 0),
        CONSTRAINT CK_Users_Role
            CHECK ([role] IN ('CUSTOMER', 'ADMIN'))
    );
END;
GO

-- 2. Xem danh sach tai khoan, khong lay cot password_hash.
SELECT
    id,
    full_name,
    email,
    phone,
    [role],
    is_active,
    created_at,
    updated_at
FROM dbo.Users
ORDER BY id;
GO

-- 3. Kiem tra so tai khoan hien co.
SELECT COUNT(*) AS total_users
FROM dbo.Users;
GO

-- Chua INSERT tai khoan mau o buoc nay.
-- Backend se bam mat khau truoc khi INSERT.
-- Khi sua ho so, Backend se gan updated_at = SYSUTCDATETIME().