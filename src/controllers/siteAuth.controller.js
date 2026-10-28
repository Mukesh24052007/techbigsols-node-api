const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SiteUserModel = require('../models/siteUser.model');

/**
 * Generate a signed JWT for a site-user.
 * Uses a dedicated payload type ('site_user') so tokens from the admin portal
 * cannot be used on site-user routes and vice-versa.
 */
const signSiteUserToken = (user) => {
  return jwt.sign(
    { userId: user.user_id, email: user.email, type: 'site_user' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );
};

const SiteAuthController = {
  /**
   * POST /api/site-auth/login
   * Body: { email, password }
   * Authenticates a site-user created through the user-master portal.
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

      const user = await SiteUserModel.findByEmail(email);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password.',
        });
      }

      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been deactivated. Please contact the administrator.',
        });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password.',
        });
      }

      const token = signSiteUserToken(user);
      const mustChangePassword = Boolean(user.mustChangePassword ?? user.must_change_password);

      return res.status(200).json({
        success: true,
        mustChangePassword,
        message: mustChangePassword
          ? 'Login successful. You must change your password before continuing.'
          : 'Login successful.',
        token,
        user: {
          userId: user.user_id,
          fullname: user.fullname,
          email: user.email,
          role: user.role || 'employee',
          moduleAccess: user.moduleAccess,
          mustChangePassword,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/site-auth/logout
   * JWT is stateless — instructs the client to discard the token.
   */
  async logout(req, res) {
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully. Please remove the token on the client.',
    });
  },

  /**
   * GET /api/site-auth/me   (site-user protected)
   * Returns the currently authenticated site-user's profile.
   */
  async me(req, res) {
    return res.status(200).json({
      success: true,
      user: req.siteUser,
    });
  },

  /**
   * POST /api/site-auth/change-password (site-user protected)
   * Mandatory/self-service password change for authenticated employee.
   * Body: { currentPassword, newPassword }
   */
  async changePassword(req, res, next) {
    try {
      const { currentPassword, newPassword } = req.body || {};

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'currentPassword and newPassword are required.',
        });
      }

      if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'newPassword must be at least 8 characters in length.',
        });
      }

      if (currentPassword === newPassword) {
        return res.status(400).json({
          success: false,
          message: 'newPassword must be different from currentPassword.',
        });
      }

      // Fetch user with password hash using authenticated session identity
      const user = await SiteUserModel.findByEmail(req.siteUser.email);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User account not found.',
        });
      }

      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({
          success: false,
          message: 'Invalid current password.',
        });
      }

      // Hash new password using bcrypt cost 12
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Atomically update password and set must_change_password = 0
      await SiteUserModel.update(req.siteUser.user_id, {
        password: hashedPassword,
        must_change_password: 0,
      });

      return res.status(200).json({
        success: true,
        message: 'Password changed successfully. You may now access all authorized modules.',
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = SiteAuthController;
