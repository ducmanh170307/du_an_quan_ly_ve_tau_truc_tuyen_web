-- FILE 3: TAO BANG TOA TAU VA DU LIEU MAU
-- Chay sau file 02_trains.sql.

-- 1. Chuyen sang database cua du an.
USE TrainTicketDB;
GO

-- 2. Tao bang toa tau neu chua ton tai.
IF OBJECT_ID(N'dbo.Carriages', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Carriages (
        id INT IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_Carriages PRIMARY KEY,
        train_id INT NOT NULL,
        carriage_number TINYINT NOT NULL,
        carriage_type VARCHAR(20) NOT NULL,
        is_active BIT NOT NULL
            CONSTRAINT DF_Carriages_IsActive DEFAULT (1),
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_Carriages_CreatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT FK_Carriages_Trains
            FOREIGN KEY (train_id) REFERENCES dbo.Trains(id),
        CONSTRAINT UQ_Carriages_Train_Number
            UNIQUE (train_id, carriage_number),
        CONSTRAINT CK_Carriages_Number
            CHECK (carriage_number > 0),
        CONSTRAINT CK_Carriages_Type
            CHECK (carriage_type IN ('SOFT_SEAT', 'SLEEPER'))
    );
END;
GO

-- 3. Moi doan tau mau co 2 toa: ghe mem va giuong nam.
INSERT INTO dbo.Carriages (train_id, carriage_number, carriage_type)
SELECT train.id, sample.carriage_number, sample.carriage_type
FROM dbo.Trains AS train
CROSS JOIN (VALUES
    (1, 'SOFT_SEAT'),
    (2, 'SLEEPER')
) AS sample(carriage_number, carriage_type)
WHERE train.code IN ('DT01', 'DT02', 'DT03')
  AND train.is_active = 1
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.Carriages AS existing
      WHERE existing.train_id = train.id
        AND existing.carriage_number = sample.carriage_number
  );
GO

-- 4. Xem cac toa kem ma doan tau.
SELECT
    carriage.id,
    carriage.train_id,
    train.code AS train_code,
    carriage.carriage_number,
    carriage.carriage_type,
    carriage.is_active
FROM dbo.Carriages AS carriage
INNER JOIN dbo.Trains AS train
    ON train.id = carriage.train_id
ORDER BY train.code, carriage.carriage_number;
GO