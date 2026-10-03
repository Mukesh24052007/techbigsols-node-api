const express = require('express');
const router = express.Router();
const AttendanceController = require('../controllers/attendance.controller');

// GET /api/attendance/ping — unauthenticated stub (Phase 1)
router.get('/ping', AttendanceController.ping);

module.exports = router;
