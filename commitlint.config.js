export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'scope-required-except': (parsed) => {
          const { type, scope } = parsed;
          // Core development types require scope
          // Auxiliary types (chore, docs, test, perf, style, ci, build, revert) are optional
          const allowedWithoutScope = [
            'chore',
            'docs',
            'test',
            'perf',
            'style',
            'ci',
            'build',
            'revert',
          ];

          if (allowedWithoutScope.includes(type)) {
            return [true];
          }

          if (!scope) {
            return [
              false,
              `scope is required for type '${type}' (optional for: ${allowedWithoutScope.join(', ')})`,
            ];
          }

          return [true];
        },
      },
    },
  ],
  rules: {
    'scope-required-except': [2, 'always'],
    'body-max-line-length': [0],
    'body-empty': [2, 'always'],
  },
};
