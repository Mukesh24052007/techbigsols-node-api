const jwt = require('jsonwebtoken');
const SiteUserModel = require('../models/siteUser.model');

/**
 * Middleware — protects routes that require a valid site-user JWT.
 *
 * Site-users log in via /api/site-auth/login and receive a token with
 * payload type 'site_user'. This middleware rejects admin tokens and
 * any other JWT that was not issued for a site-user.
 *
 * Expects:  Authorization: Bearer <token>
 */
const siteUserProtect = async (req, res, next) => {
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

    // Ensure this token belongs to a site-user, not an admin
    if (decoded.type !== 'site_user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. This route requires a site-user token.',
      });
    }

    // Confirm the site-user still exists and is active
    const siteUser = await SiteUserModel.findById(decoded.userId);
    if (!siteUser) {
      return res.status(401).json({
        success: false,
        message: 'Site user account not found.',
      });
    }

    if (!siteUser.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact the administrator.',
      });
    }

    // Attach the site-user to the request for downstream use
    req.siteUser = siteUser;

    // Server-side enforcement of mandatory first-login password change
    if (siteUser.mustChangePassword) {
      const fullPath = (req.baseUrl || '') + (req.path || '');
      const allowedPaths = [
        '/api/site-auth/change-password',
        '/api/site-auth/logout',
        '/api/site-auth/me',
        '/change-password',
        '/logout',
        '/me',
      ];
      const isAllowed = allowedPaths.some((p) => fullPath.endsWith(p));
      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'You must change your password before accessing this resource.',
        });
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = siteUserProtect;
