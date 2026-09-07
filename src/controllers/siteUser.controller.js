const bcrypt = require('bcryptjs');
const SiteUserModel = require('../models/siteUser.model');

const SiteUserController = {
  /**
   * GET /api/user-master
   * Returns all site-users (admin only).
   */
  async getAll(req, res, next) {
    try {
      const users = await SiteUserModel.findAll();
      return res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/user-master/:id
   * Returns a single site-user (admin only).
   */
  async getOne(req, res, next) {
    try {
      const user = await SiteUserModel.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ success: false, message: 'Site user not found.' });
      }
      return res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/user-master
   * Create a new site-user (admin only).
   * Body: { fullname, email, password, moduleAccess: string[] }
   */
  async create(req, res, next) {
    try {
      const { fullname, email, password, moduleAccess } = req.body;

      // --- Validation ---
      if (!fullname || !email || !password) {
        return res.status(400).json({
          success: false,
          message: 'fullname, email, and password are required.',
        });
      }

      if (!Array.isArray(moduleAccess) || moduleAccess.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one module access value must be selected.',
        });
      }

      // Validate each module value against the allowed list
      const invalidModules = moduleAccess.filter(
        (m) => !SiteUserModel.MODULES.includes(m)
      );
      if (invalidModules.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid module(s): ${invalidModules.join(', ')}. Allowed: ${SiteUserModel.MODULES.join(', ')}.`,
        });
      }

      // Check email uniqueness
      const existing = await SiteUserModel.findByEmail(email);
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A site user with this email already exists.',
        });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const user = await SiteUserModel.create({ fullname, email, password: hashedPassword, moduleAccess });

      return res.status(201).json({
        success: true,
        message: 'Site user created successfully.',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PUT /api/user-master/:id
   * Update a site-user (admin only).
   * Body: any subset of { fullname, email, password, moduleAccess, is_active }
   */
  async update(req, res, next) {
    try {
      const { fullname, email, password, moduleAccess, is_active } = req.body;

      // Validate moduleAccess if provided
      if (moduleAccess !== undefined) {
        if (!Array.isArray(moduleAccess) || moduleAccess.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'moduleAccess must be a non-empty array.',
          });
        }
        const invalidModules = moduleAccess.filter(
          (m) => !SiteUserModel.MODULES.includes(m)
        );
        if (invalidModules.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid module(s): ${invalidModules.join(', ')}.`,
          });
        }
      }

      // If email is changing, ensure it's not already taken by another user
      if (email !== undefined) {
        const existing = await SiteUserModel.findByEmail(email);
        if (existing && String(existing.id) !== String(req.params.id)) {
          return res.status(409).json({
            success: false,
            message: 'This email is already in use by another site user.',
          });
        }
      }

      // Hash new password if provided
      let hashedPassword;
      if (password) {
        hashedPassword = await bcrypt.hash(password, 12);
      }

      const updated = await SiteUserModel.update(req.params.id, {
        fullname,
        email,
        password: hashedPassword,
        moduleAccess,
        is_active,
      });

      if (!updated) {
        return res.status(404).json({ success: false, message: 'Site user not found.' });
      }

      return res.json({ success: true, message: 'Site user updated successfully.' });
    } catch (err) {
      next(err);
    }
  },

  /**
   * DELETE /api/user-master/:id
   * Delete a site-user (admin only).
   */
  async remove(req, res, next) {
    try {
      const deleted = await SiteUserModel.remove(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Site user not found.' });
      }
      return res.json({ success: true, message: 'Site user deleted successfully.' });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/user-master/modules
   * Returns the full list of available module access options.
   */
  async getModules(req, res) {
    return res.json({ success: true, data: SiteUserModel.MODULES });
  },
};

module.exports = SiteUserController;
