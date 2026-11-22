-- FILE 9: TAO BANG DON DAT VE VA CHI TIET VE
-- Chay sau 06_trip_seats.sql va 07_users.sql.
-- Tat ca moc thoi gian duoc luu theo UTC.

USE TrainTicketDB;
GO

SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;

IF DB_NAME() <> N'TrainTicketDB'
BEGIN
    THROW 50001, N'Hãy chạy file này trong TrainTicketDB.', 1;
END;

IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
   OR OBJECT_ID(N'dbo.Trips', N'U') IS NULL
   OR OBJECT_ID(N'dbo.TripSeats', N'U') IS NULL
BEGIN
    THROW 50002, N'Cần có bảng Users, Trips và TripSeats trước khi tạo bảng đặt vé.', 1;
END;

BEGIN TRY
    BEGIN TRANSACTION;

    -- 1. Don dat ve cua mot khach cho mot chuyen.
    IF OBJECT_ID(N'dbo.Bookings', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.Bookings (
            id INT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_Bookings PRIMARY KEY,
            code VARCHAR(32) NOT NULL
                CONSTRAINT UQ_Bookings_Code UNIQUE,
            user_id INT NOT NULL,
            trip_id INT NOT NULL,
            status VARCHAR(20) NOT NULL
                CONSTRAINT DF_Bookings_Status DEFAULT ('PENDING_PAYMENT'),
            total_amount DECIMAL(14, 0) NOT NULL,
            expires_at DATETIME2 NOT NULL,
            idempotency_key VARCHAR(64) COLLATE Latin1_General_100_BIN2 NOT NULL,
            created_at DATETIME2 NOT NULL
                CONSTRAINT DF_Bookings_CreatedAt DEFAULT (SYSUTCDATETIME()),
            updated_at DATETIME2 NOT NULL
                CONSTRAINT DF_Bookings_UpdatedAt DEFAULT (SYSUTCDATETIME()),

            CONSTRAINT FK_Bookings_Users
                FOREIGN KEY (user_id) REFERENCES dbo.Users(id),
            CONSTRAINT FK_Bookings_Trips
                FOREIGN KEY (trip_id) REFERENCES dbo.Trips(id),
            CONSTRAINT UQ_Bookings_User_Request
                UNIQUE (user_id, idempotency_key),
            CONSTRAINT UQ_Bookings_Id_Trip
                UNIQUE (id, trip_id),
            CONSTRAINT CK_Bookings_Code_NotBlank
                CHECK (LEN(LTRIM(RTRIM(code))) > 0),
            CONSTRAINT CK_Bookings_Request_NotBlank
                CHECK (LEN(LTRIM(RTRIM(idempotency_key))) > 0),
            CONSTRAINT CK_Bookings_Status
                CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED')),
            CONSTRAINT CK_Bookings_Total
                CHECK (total_amount >= 0),
            CONSTRAINT CK_Bookings_Expiration
                CHECK (expires_at > created_at)
        );
    END;

    -- 2. Them khoa de rang buoc chi tiet va don phai cung chuyen.
    IF NOT EXISTS (
        SELECT 1 FROM sys.key_constraints
        WHERE parent_object_id = OBJECT_ID(N'dbo.TripSeats')
          AND name = N'UQ_TripSeats_Id_Trip'
    )
    BEGIN
        ALTER TABLE dbo.TripSeats ADD CONSTRAINT UQ_TripSeats_Id_Trip
            UNIQUE (id, trip_id);
    END;

    -- 3. Moi chi tiet gom mot hanh khach, mot cho va gia luc dat.
    IF OBJECT_ID(N'dbo.BookingItems', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.BookingItems (
            id INT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_BookingItems PRIMARY KEY,
            booking_id INT NOT NULL,
            trip_id INT NOT NULL,
            trip_seat_id INT NOT NULL,
            passenger_name NVARCHAR(100) NOT NULL,
            price_snapshot DECIMAL(12, 0) NOT NULL,
            ticket_code VARCHAR(32) NULL,
            status VARCHAR(20) NOT NULL
                CONSTRAINT DF_BookingItems_Status DEFAULT ('HELD'),

            CONSTRAINT FK_BookingItems_Bookings
                FOREIGN KEY (booking_id, trip_id) REFERENCES dbo.Bookings(id, trip_id),
            CONSTRAINT FK_BookingItems_TripSeats
                FOREIGN KEY (trip_seat_id, trip_id) REFERENCES dbo.TripSeats(id, trip_id),
            CONSTRAINT UQ_BookingItems_Booking_Seat
                UNIQUE (booking_id, trip_seat_id),
            CONSTRAINT CK_BookingItems_Passenger_NotBlank
                CHECK (LEN(LTRIM(RTRIM(passenger_name))) > 0),
            CONSTRAINT CK_BookingItems_Price
                CHECK (price_snapshot >= 0),
            CONSTRAINT CK_BookingItems_Status
                CHECK (status IN ('HELD', 'ISSUED', 'CANCELLED', 'EXPIRED')),
            CONSTRAINT CK_BookingItems_Ticket
                CHECK (
                    (status = 'ISSUED' AND ticket_code IS NOT NULL
                        AND LEN(LTRIM(RTRIM(ticket_code))) > 0)
                    OR (status <> 'ISSUED' AND ticket_code IS NULL)
                )
        );
    END;

    -- 4. Khoa ngoai cho don dang giu hoac da mua cho hien tai.
    IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys
        WHERE parent_object_id = OBJECT_ID(N'dbo.TripSeats')
          AND name = N'FK_TripSeats_CurrentBooking'
    )
    BEGIN
        ALTER TABLE dbo.TripSeats WITH CHECK ADD CONSTRAINT FK_TripSeats_CurrentBooking
            FOREIGN KEY (booking_id, trip_id) REFERENCES dbo.Bookings(id, trip_id);
    END;

    -- 5. Ma ve chi duy nhat sau khi duoc cap.
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.BookingItems')
          AND name = N'UX_BookingItems_TicketCode'
    )
    BEGIN
        CREATE UNIQUE INDEX UX_BookingItems_TicketCode
            ON dbo.BookingItems (ticket_code)
            WHERE ticket_code IS NOT NULL;
    END;

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.Bookings')
          AND name = N'IX_Bookings_User_Created'
    )
    BEGIN
        CREATE INDEX IX_Bookings_User_Created
            ON dbo.Bookings (user_id, created_at DESC, id DESC);
    END;

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.Bookings')
          AND name = N'IX_Bookings_Status_Expires'
    )
    BEGIN
        CREATE INDEX IX_Bookings_Status_Expires
            ON dbo.Bookings (status, expires_at);
    END;

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.TripSeats')
          AND name = N'IX_TripSeats_Booking'
    )
    BEGIN
        CREATE INDEX IX_TripSeats_Booking
            ON dbo.TripSeats (booking_id, trip_id);
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

SELECT
    (SELECT COUNT_BIG(*) FROM dbo.Bookings) AS total_bookings,
    (SELECT COUNT_BIG(*) FROM dbo.BookingItems) AS total_booking_items;
GO