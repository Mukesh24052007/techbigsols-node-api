/**
 * Site-user must have the named module in req.siteUser.moduleAccess.
 * Use after siteUserProtect.
 */
function requireModule(moduleName) {
  return (req, res, next) => {
    const access = Array.isArray(req.siteUser?.moduleAccess)
      ? req.siteUser.moduleAccess
      : [];
    if (!access.includes(moduleName)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Missing module: ${moduleName}.`,
      });
    }
    return next();
  };
}

module.exports = requireModule;
