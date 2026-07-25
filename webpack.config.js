const path = require('path');

module.exports = {
  mode: 'production',
  entry: {
    login: './chrome/popup/login.js',
    signup: './chrome/popup/signup.js'
  },
  output: {
    filename: '[name].bundle.js',
    path: path.resolve(__dirname, 'chrome/popup')
  },
  resolve: {
    extensions: ['.js']
  }
};
