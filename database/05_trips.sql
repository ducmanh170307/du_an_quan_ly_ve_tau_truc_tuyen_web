-- FILE 5: TAO BANG CHUYEN TAU VA 30 CHUYEN MAU
-- Chay sau cac file 01 den 04.
-- Lich chay va gia trong file nay la du lieu mau de kiem thu.

USE TrainTicketDB;
GO

-- 1. Tao bang chuyen tau.
-- departure_at, arrival_at va created_at deu luu theo UTC.
IF OBJECT_ID(N'dbo.Trips', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Trips (
        id INT IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_Trips PRIMARY KEY,
        code VARCHAR(30) NOT NULL
            CONSTRAINT UQ_Trips_Code UNIQUE,
        train_id INT NOT NULL,
        origin_id INT NOT NULL,
        destination_id INT NOT NULL,
        departure_at DATETIME2 NOT NULL,
        arrival_at DATETIME2 NOT NULL,
        base_price DECIMAL(12, 0) NOT NULL,
        status VARCHAR(20) NOT NULL
            CONSTRAINT DF_Trips_Status DEFAULT ('OPEN'),
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_Trips_CreatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT FK_Trips_Trains
            FOREIGN KEY (train_id) REFERENCES dbo.Trains(id),
        CONSTRAINT FK_Trips_Origin
            FOREIGN KEY (origin_id) REFERENCES dbo.Stations(id),
        CONSTRAINT FK_Trips_Destination
            FOREIGN KEY (destination_id) REFERENCES dbo.Stations(id),
        CONSTRAINT CK_Trips_Stations
            CHECK (origin_id <> destination_id),
        CONSTRAINT CK_Trips_Time
            CHECK (arrival_at > departure_at),
        CONSTRAINT CK_Trips_Price
            CHECK (base_price >= 0),
        CONSTRAINT CK_Trips_Status
            CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
        CONSTRAINT CK_Trips_Code_NotBlank
            CHECK (LEN(LTRIM(RTRIM(code))) > 0)
    );
END;
GO

-- 2. Bat dau tu ngay mai theo gio Viet Nam (UTC+7).
DECLARE @firstDayVN DATE = DATEADD(
    DAY, 1, CONVERT(DATE, DATEADD(HOUR, 7, SYSUTCDATETIME()))
);

DECLARE @firstMidnightUtc DATETIME2 =
    DATEADD(HOUR, -7, CONVERT(DATETIME2, @firstDayVN));

-- 3. Moi tau 2 chuyen/ngay, trong 5 ngay: 3 x 2 x 5 = 30.
-- A la luot di, B la luot ve; moi chuyen mau keo dai 180 phut.
;WITH sample_trips AS (
    SELECT
        CONCAT(
            train.code, '-',
            CONVERT(CHAR(8), DATEADD(DAY, days.day_offset, @firstDayVN), 112),
            '-', route.direction
        ) AS code,
        train.id AS train_id,
        origin.id AS origin_id,
        destination.id AS destination_id,
        DATEADD(
            HOUR, route.departure_hour,
            DATEADD(DAY, days.day_offset, @firstMidnightUtc)
        ) AS departure_at,
        route.duration_minutes,
        route.base_price
    FROM (VALUES
        ('DT01', 'HN', 'HP', 7, 180, 150000, 'A'),
        ('DT01', 'HP', 'HN', 14, 180, 150000, 'B'),
        ('DT02', 'DN', 'HUE', 8, 180, 120000, 'A'),
        ('DT02', 'HUE', 'DN', 15, 180, 120000, 'B'),
        ('DT03', 'HN', 'HP', 9, 180, 150000, 'A'),
        ('DT03', 'HP', 'HN', 16, 180, 150000, 'B')
    ) AS route(
        train_code, origin_code, destination_code,
        departure_hour, duration_minutes, base_price, direction
    )
    CROSS JOIN (VALUES (0), (1), (2), (3), (4)) AS days(day_offset)
    INNER JOIN dbo.Trains AS train ON train.code = route.train_code
    INNER JOIN dbo.Stations AS origin ON origin.code = route.origin_code
    INNER JOIN dbo.Stations AS destination
        ON destination.code = route.destination_code
    WHERE train.is_active = 1
      AND origin.is_active = 1
      AND destination.is_active = 1
)
INSERT INTO dbo.Trips (
    code, train_id, origin_id, destination_id,
    departure_at, arrival_at, base_price
)
SELECT
    sample.code, sample.train_id, sample.origin_id, sample.destination_id,
    sample.departure_at,
    DATEADD(MINUTE, sample.duration_minutes, sample.departure_at),
    sample.base_price
FROM sample_trips AS sample
WHERE NOT EXISTS (
    SELECT 1
    FROM dbo.Trips AS existing
    WHERE existing.code = sample.code
);
GO

-- 4. Xem lich chay theo gio Viet Nam.
SELECT
    trip.code,
    train.code AS train_code,
    origin.code AS origin_code,
    destination.code AS destination_code,
    DATEADD(HOUR, 7, trip.departure_at) AS departure_vn,
    DATEADD(HOUR, 7, trip.arrival_at) AS arrival_vn,
    trip.base_price,
    trip.status
FROM dbo.Trips AS trip
INNER JOIN dbo.Trains AS train ON train.id = trip.train_id
INNER JOIN dbo.Stations AS origin ON origin.id = trip.origin_id
INNER JOIN dbo.Stations AS destination ON destination.id = trip.destination_id
ORDER BY trip.departure_at, trip.code;
GO

-- 5. Kiem tra tong so chuyen.
SELECT COUNT(*) AS total_trips
FROM dbo.Trips;
GO