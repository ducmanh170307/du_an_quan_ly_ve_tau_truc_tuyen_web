IF DB_ID(N'TrainTicketDB') IS NULL
    EXEC(N'CREATE DATABASE TrainTicketDB;');
GO

USE TrainTicketDB;
GO

IF OBJECT_ID(N'dbo.Stations', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Stations (
        id INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Stations PRIMARY KEY,
        code VARCHAR(10) NOT NULL CONSTRAINT UQ_Stations_Code UNIQUE,
        name NVARCHAR(100) NOT NULL,
        city NVARCHAR(100) NOT NULL,
        is_active BIT NOT NULL CONSTRAINT DF_Stations_IsActive DEFAULT (1),
        created_at DATETIME2 NOT NULL CONSTRAINT DF_Stations_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_Stations_NotBlank CHECK (
            LEN(LTRIM(RTRIM(code))) > 0 AND LEN(LTRIM(RTRIM(name))) > 0 AND LEN(LTRIM(RTRIM(city))) > 0
        )
    );
END;
GO

INSERT INTO dbo.Stations (code, name, city)
SELECT sample.code, sample.name, sample.city
FROM (VALUES
    ('HN', N'Ga Hà Nội', N'Hà Nội'),
    ('HP', N'Ga Hải Phòng', N'Hải Phòng'),
    ('DN', N'Ga Đà Nẵng', N'Đà Nẵng'),
    ('HUE', N'Ga Huế', N'Huế'),
    ('SG', N'Ga Sài Gòn', N'TP. Hồ Chí Minh')
) AS sample(code, name, city)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Stations AS station WHERE station.code = sample.code);
GO
