const jwt = require('jsonwebtoken');
const AdminModel = require('../models/admin.model');

/**
 * Middleware — protects routes that require a valid admin JWT.
 * Expects:  Authorization: Bearer <token>
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.',
      });
    }

    // Confirm admin still exists and is active
    const admin = await AdminModel.findById(decoded.id);
    if (!admin || !admin.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Admin account not found or deactivated.',
      });
    }

    // Attach admin info to request for downstream use
    req.admin = admin;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = protect;
