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
    { id: user.id, email: user.email, type: 'site_user' },
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

      return res.status(200).json({
        success: true,
        message: 'Login successful.',
        token,
        user: {
          id: user.id,
          fullname: user.fullname,
          email: user.email,
          moduleAccess: user.moduleAccess,
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
};

module.exports = SiteAuthController;
