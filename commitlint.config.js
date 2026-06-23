export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'scope-required-except': (parsed) => {
          const { type, scope } = parsed;
          const allowedWithoutScope = ['chore', 'ci', 'build', 'revert'];

          if (allowedWithoutScope.includes(type)) {
            return [true];
          }

          if (!scope) {
            return [
              false,
              `scope is required for type '${type}' (allowed without scope: ${allowedWithoutScope.join(', ')})`,
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
