const DEFAULT_WS_PATH = '/live-term/ws';

function hasArg(args, name, short) {
  const exact = [name, short].filter(Boolean);

  return args.some(arg => {
    if (exact.includes(arg)) return true;
    if (arg.startsWith(`${name}=`)) return true;
    if (short && arg.startsWith(`${short}=`)) return true;
    return false;
  });
}

function getArgValue(args, name, short) {
  const exact = [name, short].filter(Boolean);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (exact.includes(arg)) {
      return args[i + 1] || null;
    }

    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }

    if (short && arg.startsWith(`${short}=`)) {
      return arg.slice(short.length + 1);
    }
  }

  return null;
}

function normalizeWsPath(path) {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
    return withLeadingSlash.slice(0, -1);
  }

  return withLeadingSlash;
}

function parsePathList(rawValue) {
  if (rawValue == null) return [];

  if (Array.isArray(rawValue)) {
    return rawValue.map(normalizeWsPath).filter(Boolean);
  }

  const raw = String(rawValue).trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeWsPath).filter(Boolean);
      }
    } catch (_) {
      // Fall back to comma split.
    }
  }

  return raw.split(',').map(part => normalizeWsPath(part)).filter(Boolean);
}

function resolveWsPaths(args, env) {
  const cliPaths = getArgValue(args, '--paths', '-pts');
  const envPaths = env.WS_PATHS;

  const resolved =
    parsePathList(cliPaths).concat(
      parsePathList(envPaths),
    );

  if (resolved.length === 0) {
    return [DEFAULT_WS_PATH];
  }

  return [...new Set(resolved)];
}

module.exports = {
  DEFAULT_WS_PATH,
  hasArg,
  getArgValue,
  normalizeWsPath,
  resolveWsPaths,
};
