-- FILE 11: HUY DON CHO THANH TOAN VA TRA LAI CHO
-- Chay sau 10_hold_booking.sql.
USE TrainTicketDB;
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.CancelBookingHold
    @user_id INT,
    @booking_id INT
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
        THROW 51101, N'Tài khoản hoặc mã đơn không hợp lệ.', 1;

    DECLARE @trip_id INT, @lock_result INT;
    DECLARE @status VARCHAR(20), @code VARCHAR(32);
    DECLARE @now DATETIME2, @expires_at DATETIME2;
    DECLARE @trip_lock NVARCHAR(255);

    BEGIN TRY
        -- Chi tim chuyen theo don thuoc tai khoan nay.
        SELECT @trip_id = trip_id
   FROM dbo.Bookings
        WHERE id = @booking_id AND user_id = @user_id;

        IF @trip_id IS NULL
            THROW 51102, N'Không tìm thấy đơn của bạn.', 1;

        BEGIN TRANSACTION;

        -- Dung cung khoa voi CreateBookingHold de tuan tu hoa cap nhat cho.
        SET @trip_lock = CONCAT(N'TrainTicket:Trip:', @trip_id);
        EXEC @lock_result = sys.sp_getapplock
            @Resource = @trip_lock, @LockMode = 'Exclusive',
            @LockOwner = 'Transaction', @LockTimeout = 5000;

        IF @lock_result < 0
            THROW 51104, N'Chuyến đang có giao dịch khác. Vui lòng thử lại.', 1;

        IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE id = @user_id AND is_active = 1)
            THROW 51105, N'Tài khoản không còn hoạt động.', 1;

        SELECT @status = status, @code = code, @expires_at = expires_at
        FROM dbo.Bookings WITH (UPDLOCK)
        WHERE id = @booking_id AND user_id = @user_id AND trip_id = @trip_id;
        
        IF @status IS NULL
            THROW 51102, N'Không tìm thấy đơn của bạn.', 1;

        IF @status = 'PAID'
            THROW 51103, N'Đơn đã thanh toán. Vui lòng tải lại danh sách đơn.', 1;

        IF @status = 'PENDING_PAYMENT'
        BEGIN
            SET @now = SYSUTCDATETIME();
            SET @status = CASE WHEN @expires_at <= @now THEN 'EXPIRED' ELSE 'CANCELLED' END;

            UPDATE dbo.Bookings
            SET status = @status, updated_at = @now
            WHERE id = @booking_id AND user_id = @user_id AND trip_id = @trip_id;

            UPDATE dbo.TripSeats
            SET state = 'AVAILABLE', booking_id = NULL, hold_expires_at = NULL
            WHERE booking_id = @booking_id AND trip_id = @trip_id AND state = 'HELD';

            UPDATE dbo.BookingItems
            SET status = @status
            WHERE booking_id = @booking_id AND trip_id = @trip_id AND status = 'HELD';
        END;

        COMMIT TRANSACTION;

        SELECT @booking_id AS id, @code AS code, @status AS status;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
        END CATCH;
END;
GO

IF USER_ID(N'train_app') IS NOT NULL
    GRANT EXECUTE ON OBJECT::dbo.CancelBookingHold TO [train_app];
GO

SELECT OBJECT_ID(N'dbo.CancelBookingHold', N'P') AS procedure_id;
GO
