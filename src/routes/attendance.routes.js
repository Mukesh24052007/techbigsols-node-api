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

// Attendance 2.0: QR Check-In & Check-Out
router.post('/qr/check-in', employeeGuard, AttendanceController.qrCheckIn);
router.post('/qr/check-out', employeeGuard, AttendanceController.qrCheckOut);

// ── Admin Routes (admin JWT) ───────────────────────────────────────────────
// Attendance 2.0: QR Session Management, Daily Logs, Manual Overrides & Audit Trail
router.post('/admin/qr/generate', protect, AttendanceController.adminQrGenerate);
router.get('/admin/qr/active', protect, AttendanceController.adminQrGetActive);
router.get('/admin/daily-logs', protect, AttendanceController.adminGetDailyLogs);
router.post('/admin/manual-override', protect, AttendanceController.adminManualOverride);
router.get('/admin/audit-logs', protect, AttendanceController.adminGetAuditLogs);
// Face enrollment
router.post('/admin/employees/:userId/face', protect, AttendanceController.adminEnrolFace);
router.delete('/admin/employees/:userId/face', protect, AttendanceController.adminDeleteFace);

// Offices CRUD
router.post('/admin/offices', protect, AttendanceController.adminCreateOffice);
router.get('/admin/offices', protect, AttendanceController.adminGetOffices);
router.get('/admin/offices/:id', protect, AttendanceController.adminGetOfficeById);
router.put('/admin/offices/:id', protect, AttendanceController.adminUpdateOffice);
router.delete('/admin/offices/:id', protect, AttendanceController.adminDeleteOffice);

// Employees & Profile
router.get('/admin/employees', protect, AttendanceController.adminGetEmployees);
router.put('/admin/employees/:userId/profile', protect, AttendanceController.adminUpdateEmployeeProfile);
router.get('/admin/employees/:userId/timeline', protect, AttendanceController.adminGetTimeline);

// Real-Time & Live
router.get('/admin/live', protect, AttendanceController.adminGetLive);
router.get('/admin/stream', protect, AttendanceController.adminGetStream);

// Reports & Attempts
router.get('/admin/report', protect, AttendanceController.adminGetReport);
router.get('/admin/attempts', protect, AttendanceController.adminGetAttempts);

// Regularizations & Manual Record Patches
router.get('/admin/regularizations', protect, AttendanceController.adminGetRegularizations);
router.post('/admin/regularizations/:id/approve', protect, AttendanceController.adminApproveRegularization);
router.post('/admin/regularizations/:id/reject', protect, AttendanceController.adminRejectRegularization);
router.patch('/admin/records/:id', protect, AttendanceController.adminPatchRecord);

// Leaves
router.post('/admin/leaves', protect, AttendanceController.adminCreateLeave);
router.get('/admin/leaves', protect, AttendanceController.adminGetLeaves);
router.patch('/admin/leaves/:id', protect, AttendanceController.adminCancelLeave);
router.delete('/admin/leaves/:id', protect, AttendanceController.adminCancelLeave);

module.exports = router;
