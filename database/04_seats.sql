-- FILE 4: TAO BANG GHE/GIUONG VA DU LIEU MAU
-- Chay sau file 03_carriages.sql.
-- Du lieu mau: 12 cho moi toa, 6 toa = 72 cho.

-- 1. Chuyen sang database cua du an.
USE TrainTicketDB;
GO

-- 2. Tao bang cho ngoi/giuong neu chua ton tai.
IF OBJECT_ID(N'dbo.Seats', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Seats (
        id INT IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_Seats PRIMARY KEY,
        carriage_id INT NOT NULL,
        seat_number TINYINT NOT NULL,
        is_active BIT NOT NULL
            CONSTRAINT DF_Seats_IsActive DEFAULT (1),
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_Seats_CreatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT FK_Seats_Carriages
            FOREIGN KEY (carriage_id) REFERENCES dbo.Carriages(id),
        CONSTRAINT UQ_Seats_Carriage_Number
            UNIQUE (carriage_id, seat_number),
        CONSTRAINT CK_Seats_Number
            CHECK (seat_number > 0)
    );
END;
GO

-- 3. Them 12 cho cho moi toa mau, khong chen lai cho da co.
INSERT INTO dbo.Seats (carriage_id, seat_number)
SELECT carriage.id, sample.seat_number
FROM dbo.Carriages AS carriage
INNER JOIN dbo.Trains AS train
    ON train.id = carriage.train_id
CROSS JOIN (VALUES
    (1), (2), (3), (4), (5), (6),
    (7), (8), (9), (10), (11), (12)
) AS sample(seat_number)
WHERE train.code IN ('DT01', 'DT02', 'DT03')
  AND carriage.carriage_number IN (1, 2)
  AND train.is_active = 1
  AND carriage.is_active = 1
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.Seats AS existing
      WHERE existing.carriage_id = carriage.id
        AND existing.seat_number = sample.seat_number
  );
GO

-- 4. Kiem tra so cho cua tung toa.
SELECT
    train.code AS train_code,
    carriage.carriage_number,
    carriage.carriage_type,
    COUNT(seat.id) AS total_seats
FROM dbo.Carriages AS carriage
INNER JOIN dbo.Trains AS train
    ON train.id = carriage.train_id
LEFT JOIN dbo.Seats AS seat
    ON seat.carriage_id = carriage.id
GROUP BY train.code, carriage.carriage_number, carriage.carriage_type
ORDER BY train.code, carriage.carriage_number;
GO

-- 5. Kiem tra tong so cho trong database.
SELECT COUNT(*) AS total_seats
FROM dbo.Seats;
GO