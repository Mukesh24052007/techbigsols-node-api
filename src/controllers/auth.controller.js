const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdminModel = require('../models/admin.model');

/**
 * Generate a signed JWT for an admin
 */
const signToken = (admin) => {
  return jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );
};

const AuthController = {
  /**
   * POST /api/auth/login
   * Body: { email, password }
   */
  async login(req, res, next) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email and password are required.',
        });
      }

      // Fetch admin including hashed password
      const admin = await AdminModel.findByEmail(email);

      if (!admin) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password.',
        });
      }

      if (!admin.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been deactivated. Contact support.',
        });
      }

      const isMatch = await bcrypt.compare(password, admin.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password.',
        });
      }

      const token = signToken(admin);

      return res.status(200).json({
        success: true,
        message: 'Login successful.',
        token,
        admin: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/auth/logout
   * JWT is stateless — client should discard the token.
   * This endpoint serves as a clean logout signal.
   */
  async logout(req, res) {
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully. Please remove the token on the client.',
    });
  },

  /**
   * GET /api/auth/me   (protected)
   * Returns the currently authenticated admin's profile.
   */
  async me(req, res) {
    return res.status(200).json({
      success: true,
      admin: req.admin,
    });
  },
};

module.exports = AuthController;
