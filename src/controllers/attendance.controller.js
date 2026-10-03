const AttendanceController = {
  /**
   * GET /api/attendance/ping
   * Unauthenticated liveness stub for the attendance module.
   */
  async ping(req, res, next) {
    try {
      return res.status(200).json({
        success: true,
        message: 'attendance ok',
        data: { module: 'attendance' },
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = AttendanceController;
