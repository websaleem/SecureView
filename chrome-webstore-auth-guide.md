# Generating Chrome Web Store API Credentials

To automate publishing your Chrome extension, you need three secrets: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, and `CWS_REFRESH_TOKEN`. You generate these from the Google Cloud Console.

Follow these steps carefully:

## 1. Enable the Chrome Web Store API
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new Project (e.g., "SecureView CI").
3. Go to **APIs & Services > Library**.
4. Search for **Chrome Web Store API** and click **Enable**.

## 2. Configure the OAuth Consent Screen
1. Go to **APIs & Services > OAuth consent screen**.
2. Select **External** and click Create.
3. Fill in the required fields (App name, User support email, Developer contact email). You can ignore the rest.
4. Click **Save and Continue** through the Scopes and Test Users screens.

## 3. Create OAuth Credentials
1. Go to **APIs & Services > Credentials**.
2. Click **Create Credentials** > **OAuth client ID**.
3. Select **Desktop app** as the Application type and give it a name.
4. Click Create. 
5. A popup will display your **Client ID** (`CWS_CLIENT_ID`) and **Client Secret** (`CWS_CLIENT_SECRET`). **Copy these down into your GitHub Secrets.**

## 4. Get the Refresh Token
Now you need to authorize this client to get a refresh token.

1. Copy the following URL, replacing `YOUR_CLIENT_ID` with the Client ID you just generated:
   ```text
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
   ```
2. Paste that URL into your browser while logged into the Google Account that owns the Chrome Web Store Developer dashboard.
3. Follow the prompts to authorize the app. It will give you an **Authorization Code**.
4. To exchange this code for a Refresh Token, you need to make a `POST` request. You can run this command in your terminal (using `curl`):

   ```bash
   curl "https://accounts.google.com/o/oauth2/token" -d \
   "client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&code=YOUR_AUTHORIZATION_CODE&grant_type=authorization_code&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
   ```
5. The response will be a JSON object containing your `refresh_token`. Copy this value into your GitHub Secrets as `CWS_REFRESH_TOKEN`.

You are now fully set up! Go back to GitHub Actions and trigger the deployment again.
