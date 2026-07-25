import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const CLIENT_ID = "1bpn546e7vk1bm95ncbr0u5ma8";
const REGION = "ap-southeast-2";

const client = new CognitoIdentityProviderClient({ region: REGION });

export async function loginUser(username, password) {
  const command = new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  });

  try {
    const response = await client.send(command);
    if (response.AuthenticationResult) {
      // Store tokens
      await chrome.storage.local.set({
        accessToken: response.AuthenticationResult.AccessToken,
        idToken: response.AuthenticationResult.IdToken,
        refreshToken: response.AuthenticationResult.RefreshToken
      });
      return true;
    }
  } catch (err) {
    console.error("Login failed", err);
    throw err;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('login-btn');
  const errorMsg = document.getElementById('error-msg');
  const userIn = document.getElementById('username');
  const passIn = document.getElementById('password');

  loginBtn.addEventListener('click', async () => {
    errorMsg.style.display = 'none';
    const u = userIn.value.trim();
    const p = passIn.value;
    if (!u || !p) {
      errorMsg.textContent = "Please enter email and password.";
      errorMsg.style.display = "block";
      return;
    }
    
    loginBtn.textContent = "Logging In...";
    loginBtn.disabled = true;
    
    try {
      await loginUser(u, p);
      window.location.href = "popup.html"; // Go back to main popup
    } catch (err) {
      errorMsg.textContent = err.message || "Login failed.";
      errorMsg.style.display = "block";
      loginBtn.textContent = "Log In";
      loginBtn.disabled = false;
    }
  });
});
