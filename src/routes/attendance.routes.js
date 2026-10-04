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
