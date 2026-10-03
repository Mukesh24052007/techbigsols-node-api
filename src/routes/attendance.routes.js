const express = require('express');
const router = express.Router();
const AttendanceController = require('../controllers/attendance.controller');
const siteUserProtect = require('../middlewares/siteUserProtect');
const requireModule = require('../middlewares/requireModule');
const protect = require('../middlewares/protect');

// Public liveness probe
router.get('/ping', AttendanceController.ping);

// ── Employee Routes (site-user JWT + Attendance module access) ─────────────
const employeeGuard = [siteUserProtect, requireModule('Attendance')];

router.get('/me/status', employeeGuard, AttendanceController.getStatus);
router.post('/me/consent', employeeGuard, AttendanceController.recordConsent);
router.post('/challenge', employeeGuard, AttendanceController.requestChallenge);
router.post('/check-in', employeeGuard, AttendanceController.checkIn);
router.post('/heartbeat', employeeGuard, AttendanceController.heartbeat);
router.post('/reverify', employeeGuard, AttendanceController.reverify);
router.post('/check-out', employeeGuard, AttendanceController.checkOut);
router.get('/me/history', employeeGuard, AttendanceController.getHistory);
router.post('/regularization', employeeGuard, AttendanceController.requestRegularization);

// ── Admin Routes (admin JWT) ───────────────────────────────────────────────
router.post('/admin/employees/:userId/face', protect, AttendanceController.adminEnrolFace);
router.delete('/admin/employees/:userId/face', protect, AttendanceController.adminDeleteFace);

module.exports = router;
