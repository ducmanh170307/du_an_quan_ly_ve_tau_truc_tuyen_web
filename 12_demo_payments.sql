USE TrainTicketDB;
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF OBJECT_ID(N'dbo.Payments', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Payments (
        id INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Payments PRIMARY KEY,
        booking_id INT NOT NULL CONSTRAINT FK_Payments_Bookings REFERENCES dbo.Bookings(id),
        amount DECIMAL(14, 0) NOT NULL CONSTRAINT CK_Payments_Amount CHECK (amount >= 0),
        status VARCHAR(8) NOT NULL,
        method VARCHAR(8) NOT NULL CONSTRAINT DF_Payments_Method DEFAULT ('DEMO'),
        idempotency_key VARCHAR(64) COLLATE Latin1_General_100_BIN2 NOT NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_Payments_CreatedAt DEFAULT SYSUTCDATETIME(),
        paid_at DATETIME2 NULL,
        CONSTRAINT UQ_Payments_Booking_Request UNIQUE (booking_id, idempotency_key),
        CONSTRAINT CK_Payments_Result CHECK (
            (status = 'SUCCESS' AND paid_at IS NOT NULL) OR (status = 'FAILED' AND paid_at IS NULL)
        ),
        CONSTRAINT CK_Payments_Method CHECK (method = 'DEMO'),
        CONSTRAINT CK_Payments_Key CHECK (DATALENGTH(idempotency_key) BETWEEN 1 AND 64)
    );
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.Payments') AND name = N'UX_Payments_OneSuccess'
)
BEGIN
    CREATE UNIQUE INDEX UX_Payments_OneSuccess ON dbo.Payments (booking_id) WHERE status = 'SUCCESS';
    CREATE INDEX IX_Payments_Status_PaidAt ON dbo.Payments (status, paid_at) INCLUDE (booking_id, amount);
END;
GO

CREATE OR ALTER PROCEDURE dbo.ReleaseTripExpiredHolds
    @trip_id INT,
    @now DATETIME2
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @trip_lock NVARCHAR(255) = CONCAT(N'TrainTicket:Trip:', @trip_id);
    IF XACT_STATE() <> 1 OR APPLOCK_MODE(N'public', @trip_lock, 'Transaction') <> 'Exclusive'
        THROW 51206, N'Cần khóa chuyến trước khi trả chỗ đã hết hạn.', 1;

    DECLARE @expired TABLE (booking_id INT PRIMARY KEY);
    UPDATE dbo.Bookings
    SET status = 'EXPIRED', updated_at = @now
    OUTPUT INSERTED.id INTO @expired (booking_id)
    WHERE trip_id = @trip_id AND status = 'PENDING_PAYMENT' AND expires_at <= @now;

    UPDATE seat
    SET state = 'AVAILABLE', booking_id = NULL, hold_expires_at = NULL
    FROM dbo.TripSeats AS seat
    INNER JOIN @expired AS expired ON expired.booking_id = seat.booking_id
    WHERE seat.trip_id = @trip_id AND seat.state = 'HELD';

    UPDATE item
    SET status = 'EXPIRED'
    FROM dbo.BookingItems AS item
    INNER JOIN @expired AS expired ON expired.booking_id = item.booking_id
    WHERE item.trip_id = @trip_id AND item.status = 'HELD';
END;
GO

CREATE OR ALTER PROCEDURE dbo.PayBookingDemo
    @user_id INT,
    @booking_id INT,
    @idempotency_key VARCHAR(256),
    @outcome VARCHAR(16)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET ANSI_PADDING ON;
    SET ANSI_WARNINGS ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;

    IF @user_id IS NULL OR @user_id < 1 OR @booking_id IS NULL OR @booking_id < 1
        OR @idempotency_key IS NULL OR DATALENGTH(@idempotency_key) NOT BETWEEN 1 AND 64
        OR @idempotency_key COLLATE Latin1_General_100_BIN2 LIKE '%[^0-9A-Za-z_-]%'
        OR @outcome IS NULL OR @outcome COLLATE Latin1_General_100_BIN2 NOT IN ('SUCCESS', 'FAILED')
        THROW 51201, N'Thông tin thanh toán mô phỏng không hợp lệ.', 1;

    DECLARE @trip_id INT, @lock_result INT, @payment_id INT, @seat_count INT;
    DECLARE @status VARCHAR(20), @payment_status VARCHAR(8), @code VARCHAR(32);
    DECLARE @total DECIMAL(14, 0), @now DATETIME2, @paid_at DATETIME2;
    DECLARE @is_replay BIT = 0;

    SELECT @trip_id = trip_id FROM dbo.Bookings WHERE id = @booking_id AND user_id = @user_id;
    IF @trip_id IS NULL
        THROW 51202, N'Không tìm thấy đơn của bạn.', 1;

    DECLARE @trip_lock NVARCHAR(255) = CONCAT(N'TrainTicket:Trip:', @trip_id);

    BEGIN TRY
        BEGIN TRANSACTION;
        EXEC @lock_result = sys.sp_getapplock
            @Resource = @trip_lock, @LockMode = 'Exclusive',
            @LockOwner = 'Transaction', @LockTimeout = 5000;
        IF @lock_result < 0
            THROW 51204, N'Chuyến đang có giao dịch khác. Vui lòng thử lại.', 1;

        IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE id = @user_id AND is_active = 1 AND [role] = 'CUSTOMER')
            THROW 51207, N'Tài khoản khách hàng không còn hoạt động.', 1;

        SET @now = SYSUTCDATETIME();
        EXEC dbo.ReleaseTripExpiredHolds @trip_id, @now;

        SELECT @status = status, @code = code, @total = total_amount
        FROM dbo.Bookings WITH (UPDLOCK)
        WHERE id = @booking_id AND user_id = @user_id AND trip_id = @trip_id;
        IF @status IS NULL
            THROW 51202, N'Không tìm thấy đơn của bạn.', 1;

        SELECT @payment_id = id, @payment_status = status, @paid_at = paid_at
        FROM dbo.Payments
        WHERE booking_id = @booking_id AND idempotency_key = @idempotency_key;

        IF @payment_id IS NOT NULL
        BEGIN
            IF @payment_status <> @outcome
                THROW 51205, N'Mã yêu cầu này đã được dùng cho kết quả khác.', 1;
            SET @is_replay = 1;
        END
        ELSE IF @status = 'PAID'
        BEGIN
            SELECT @payment_id = id, @payment_status = status, @paid_at = paid_at
            FROM dbo.Payments WHERE booking_id = @booking_id AND status = 'SUCCESS';
            SET @is_replay = 1;
        END
        ELSE IF @status = 'PENDING_PAYMENT'
        BEGIN
            SET @payment_status = @outcome;
            SET @paid_at = CASE WHEN @outcome = 'SUCCESS' THEN @now ELSE NULL END;
            INSERT INTO dbo.Payments (booking_id, amount, status, idempotency_key, created_at, paid_at)
            VALUES (@booking_id, @total, @outcome, @idempotency_key, @now, @paid_at);
            SET @payment_id = CONVERT(INT, SCOPE_IDENTITY());

            IF @outcome = 'SUCCESS'
            BEGIN
                SELECT @seat_count = COUNT(*) FROM dbo.BookingItems
                WHERE booking_id = @booking_id AND trip_id = @trip_id AND status = 'HELD';
                IF @seat_count < 1
                    THROW 51203, N'Đơn không có đủ chỗ giữ để cấp vé.', 1;

                UPDATE seat
                SET state = 'BOOKED', hold_expires_at = NULL
                FROM dbo.TripSeats AS seat
                INNER JOIN dbo.BookingItems AS item ON item.trip_seat_id = seat.id
                    AND item.booking_id = @booking_id AND item.trip_id = @trip_id AND item.status = 'HELD'
                WHERE seat.booking_id = @booking_id AND seat.trip_id = @trip_id
                    AND seat.state = 'HELD' AND seat.hold_expires_at > @now;
                IF @@ROWCOUNT <> @seat_count
                    THROW 51203, N'Đơn không có đủ chỗ giữ để cấp vé.', 1;

                UPDATE dbo.BookingItems
                SET status = 'ISSUED', ticket_code = REPLACE(CONVERT(VARCHAR(36), NEWID()), '-', '')
                WHERE booking_id = @booking_id AND trip_id = @trip_id AND status = 'HELD';
                UPDATE dbo.Bookings SET status = 'PAID', updated_at = @now WHERE id = @booking_id;
                SET @status = 'PAID';
            END;
        END;
        COMMIT TRANSACTION;

        SELECT @booking_id AS id, @code AS code, @status AS status, @total AS total_amount,
               @payment_id AS payment_id, @payment_status AS payment_status,
               @paid_at AS paid_at, @is_replay AS is_replay;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.ExpireBookingHolds
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET ANSI_PADDING ON;
    SET ANSI_WARNINGS ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;

    DECLARE @now DATETIME2 = SYSUTCDATETIME();
    DECLARE @due TABLE (trip_id INT PRIMARY KEY);
    DECLARE @trip_id INT, @lock_result INT, @trip_lock NVARCHAR(255);
    INSERT INTO @due (trip_id)
    SELECT TOP (20) trip_id FROM dbo.Bookings
    WHERE status = 'PENDING_PAYMENT' AND expires_at <= @now
    GROUP BY trip_id ORDER BY MIN(expires_at), trip_id;

    BEGIN TRY
        WHILE EXISTS (SELECT 1 FROM @due)
        BEGIN
            SELECT @trip_id = MIN(trip_id) FROM @due;
            DELETE FROM @due WHERE trip_id = @trip_id;
            SET @trip_lock = CONCAT(N'TrainTicket:Trip:', @trip_id);

            BEGIN TRANSACTION;
            EXEC @lock_result = sys.sp_getapplock
                @Resource = @trip_lock, @LockMode = 'Exclusive',
                @LockOwner = 'Transaction', @LockTimeout = 0;
            IF @lock_result >= 0
                EXEC dbo.ReleaseTripExpiredHolds @trip_id, @now;
            COMMIT TRANSACTION;
        END;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

IF USER_ID(N'train_app') IS NOT NULL
BEGIN
    GRANT SELECT ON OBJECT::dbo.Payments TO [train_app];
    GRANT EXECUTE ON OBJECT::dbo.PayBookingDemo TO [train_app];
    GRANT EXECUTE ON OBJECT::dbo.ExpireBookingHolds TO [train_app];
END;
GO
