-- FILE 2: TAO BANG DOAN TAU VA DU LIEU MAU
-- Mo file bang SSMS va chay toan bo bang F5.

-- 1. Chuyen sang database cua du an.
USE TrainTicketDB;
GO

-- 2. Tao bang doan tau neu chua ton tai.
IF OBJECT_ID(N'dbo.Trains', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Trains (
        id INT IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_Trains PRIMARY KEY,
        code VARCHAR(10) NOT NULL
            CONSTRAINT UQ_Trains_Code UNIQUE,
        name NVARCHAR(100) NOT NULL,
        is_active BIT NOT NULL
            CONSTRAINT DF_Trains_IsActive DEFAULT (1),
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_Trains_CreatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT CK_Trains_Code_NotBlank
            CHECK (LEN(LTRIM(RTRIM(code))) > 0),
        CONSTRAINT CK_Trains_Name_NotBlank
            CHECK (LEN(LTRIM(RTRIM(name))) > 0)
    );
END;
GO

-- 3. Nap 3 doan tau mau, khong chen lai ma tau da co.
INSERT INTO dbo.Trains (code, name)
SELECT sample.code, sample.name
FROM (VALUES
    ('DT01', N'Đoàn tàu số 01'),
    ('DT02', N'Đoàn tàu số 02'),
    ('DT03', N'Đoàn tàu số 03')
) AS sample(code, name)
WHERE NOT EXISTS (
    SELECT 1
    FROM dbo.Trains AS existing
    WHERE existing.code = sample.code
);
GO

-- 4. Xem ket qua.
SELECT id, code, name, is_active, created_at
FROM dbo.Trains
ORDER BY id;
GO