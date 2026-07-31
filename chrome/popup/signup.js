import { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { loginUser } from "./login.js";

/* global SV_CONFIG */
const CLIENT_ID = SV_CONFIG.COGNITO_CLIENT_ID;
const REGION = SV_CONFIG.COGNITO_REGION;

const client = new CognitoIdentityProviderClient({ region: REGION });

document.addEventListener('DOMContentLoaded', () => {
  const accountTypeRadios = document.querySelectorAll('input[name="accountType"]');
  const parentNameGroup = document.getElementById('parentNameGroup');

  // Toggle Parent Name field based on Account Type
  accountTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'Child') {
        parentNameGroup.classList.remove('hidden');
      } else {
        parentNameGroup.classList.add('hidden');
      }
    });
  });

  const signupBtn = document.getElementById('signup-btn');
  const errorMsg = document.getElementById('error-msg');
  const successMsg = document.getElementById('success-msg');
  const signupForm = document.getElementById('signup-form');
  const verifyForm = document.getElementById('verify-form');
  const verifyBtn = document.getElementById('verify-btn');
  const verifyErrorMsg = document.getElementById('verify-error-msg');

  let signedUpEmail = "";
  let signedUpPassword = "";

  signupBtn.addEventListener('click', async () => {
    errorMsg.style.display = 'none';
    
    const fullName = document.getElementById('fullName').value.trim();
    const accountType = document.querySelector('input[name="accountType"]:checked').value;
    const parentName = document.getElementById('parentName').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!fullName || !email || !password) {
      errorMsg.textContent = "Full Name, Email, and Password are required.";
      errorMsg.style.display = "block";
      return;
    }

    if (accountType === 'Child' && !parentName) {
      errorMsg.textContent = "Parent Full Name is required for Child accounts.";
      errorMsg.style.display = "block";
      return;
    }

    signupBtn.textContent = "Creating Account...";
    signupBtn.disabled = true;

    try {
      // Prepare user attributes
      const userAttributes = [
        { Name: "name", Value: fullName },
        { Name: "custom:account_type", Value: accountType }
      ];

      if (accountType === 'Child') {
        userAttributes.push({ Name: "custom:parent_name", Value: parentName });
      }

      const command = new SignUpCommand({
        ClientId: CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: userAttributes
      });

      await client.send(command);

      signedUpEmail = email;
      signedUpPassword = password;

      signupForm.classList.add('hidden');
      successMsg.classList.remove('hidden');
      verifyForm.classList.remove('hidden');
    } catch (err) {
      errorMsg.textContent = err.message || "Signup failed.";
      errorMsg.style.display = "block";
      signupBtn.textContent = "Sign Up";
      signupBtn.disabled = false;
    }
  });

  verifyBtn.addEventListener('click', async () => {
    verifyErrorMsg.style.display = 'none';
    const code = document.getElementById('verifyCode').value.trim();

    if (!code) {
      verifyErrorMsg.textContent = "Please enter the verification code.";
      verifyErrorMsg.style.display = "block";
      return;
    }

    verifyBtn.textContent = "Verifying...";
    verifyBtn.disabled = true;

    try {
      const confirmCommand = new ConfirmSignUpCommand({
        ClientId: CLIENT_ID,
        Username: signedUpEmail,
        ConfirmationCode: code
      });

      await client.send(confirmCommand);

      // Auto-login after verification
      try {
        await loginUser(signedUpEmail, signedUpPassword);
        
        // Notify background script that a new user signed up so it can send the welcome email
        chrome.runtime.sendMessage({ type: "SIGNUP_SUCCESS" }).catch(() => {});
        
        signedUpPassword = "";  // Clear from memory immediately
        signedUpEmail = "";
        successMsg.textContent = "Verification successful! Logging you in...";
        verifyForm.classList.add('hidden');
      } catch (loginErr) {
        signedUpPassword = "";  // Clear even on failure
        verifyErrorMsg.textContent = "Verification succeeded, but auto-login failed. Please log in manually.";
        verifyErrorMsg.style.display = "block";
        verifyBtn.textContent = "Verify Account";
        verifyBtn.disabled = false;
      }
    } catch (err) {
      verifyErrorMsg.textContent = err.message || "Verification failed.";
      verifyErrorMsg.style.display = "block";
      verifyBtn.textContent = "Verify Account";
      verifyBtn.disabled = false;
    }
  });
});
