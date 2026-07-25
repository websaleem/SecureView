import json
import boto3
import os
import re

ses_client = boto3.client('ses', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))
cognito_client = boto3.client('cognito-idp', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))

# ─── Security utilities ───────────────────────────────────────────────────────

def escape_html(s):
    """Escape user-controlled strings before interpolating into HTML."""
    if s is None:
        return ""
    return (str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;"))

_HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')

def safe_color(c):
    """Validate a CSS color value. Returns neutral grey if invalid."""
    if c and _HEX_COLOR_RE.match(str(c)):
        return str(c)
    return "#7F8C8D"


def lambda_handler(event, context):
    try:
        # Read access token from Authorization header (preferred) or body (fallback)
        headers = event.get('headers', {}) or {}
        auth_header = headers.get('Authorization', '') or headers.get('authorization', '')
        access_token = None
        if auth_header.startswith('Bearer '):
            access_token = auth_header[7:]
        
        if not access_token:
            # Fallback: read from body for backwards compatibility
            body = json.loads(event.get('body', '{}'))
            access_token = body.get('accessToken')
        else:
            body = json.loads(event.get('body', '{}'))
        
        if not access_token:
            return {'statusCode': 401, 'body': json.dumps({'message': 'Missing authentication'})}
            
        # Verify user via Cognito
        user_response = cognito_client.get_user(AccessToken=access_token)
        email = next((attr['Value'] for attr in user_response['UserAttributes'] if attr['Name'] == 'email'), None)
        name = next((attr['Value'] for attr in user_response['UserAttributes'] if attr['Name'] == 'name'), 'User')

        days = body.get('days', [])
        action = body.get('action', 'report')
        raw_freq = body.get('frequency', 'weekly')
        freq = raw_freq.capitalize() if isinstance(raw_freq, str) and raw_freq.lower() in ('daily', 'weekly') else 'Daily'
        
        if not email:
            return {'statusCode': 400, 'body': json.dumps({'message': 'User has no email'})}

        # Escape user-controlled values before HTML interpolation
        safe_name = escape_html(name)

        if action == 'welcome':
            html_content = f"""
            <html>
            <head>
              <style>
                body {{ font-family: -apple-system, sans-serif; color: #333; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                .header {{ text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 10px; margin-bottom: 20px; }}
                .content {{ margin-bottom: 30px; line-height: 1.6; }}
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h2>Welcome to SecureView, {safe_name}!</h2>
                </div>
                <div class="content">
                  <p>Thanks for installing SecureView. We're excited to help you understand your browsing habits.</p>
                  <p><strong>What to expect:</strong></p>
                  <ul>
                    <li><strong>Daily Tracking:</strong> We'll automatically categorize your web activity using AI.</li>
                    <li><strong>Regular Reports:</strong> You'll receive emails like this one, summarizing your browsing time across different categories (like Technology, Social, Finance, etc.).</li>
                    <li><strong>Privacy First:</strong> Your detailed browsing history stays on your device. We only send summarized category data to generate your reports.</li>
                  </ul>
                  <p>Happy browsing!</p>
                </div>
              </div>
            </body>
            </html>
            """
            subject = 'Welcome to SecureView!'
        elif action == 'report':
            # Compute totals for report
            total_seconds_all = sum(d.get('totalSeconds', 0) for d in days)
            total_hours = total_seconds_all / 3600

            # Create basic HTML report
            html_content = f"""
            <html>
            <head>
              <style>
                body {{ font-family: -apple-system, sans-serif; color: #333; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                .header {{ text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 10px; margin-bottom: 20px; }}
                .stats {{ margin-bottom: 30px; }}
                .day-card {{ background: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; margin-bottom: 10px; border-radius: 8px; }}
                .graph-bar {{ display: flex; height: 30px; border-radius: 4px; overflow: hidden; margin-top: 10px; }}
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h2>SecureView {freq} Report for {safe_name}</h2>
                  <p>Total Browsing Time: <strong>{total_hours:.1f} hours</strong></p>
                </div>
                <div class="stats">
                  <h3>{freq} Breakdown</h3>
            """

            for day in days:
                date_str = escape_html(day.get('label', 'Unknown Date'))
                day_total = day.get('totalSeconds', 0)
                
                # Categories
                cats = day.get('categories', {})
                
                # Simple horizontal bar graph in HTML
                graph_html = ""
                for cat_name, cat_data in cats.items():
                    if day_total > 0:
                        # Fix: read 'seconds' (the actual key), not 'time'
                        pct = (cat_data.get('seconds', 0) / day_total) * 100
                        color = safe_color(cat_data.get('color'))
                        safe_cat_name = escape_html(cat_name)
                        if pct > 0:
                            graph_html += f'<div style="width: {pct:.1f}%; background-color: {color};" title="{safe_cat_name}"></div>'

                html_content += f"""
                  <div class="day-card">
                    <div style="display: flex; justify-content: space-between;">
                      <strong>{date_str}</strong>
                      <span>{day_total // 3600}h {(day_total % 3600) // 60}m</span>
                    </div>
                    <div class="graph-bar">
                      {graph_html}
                    </div>
                  </div>
                """

            html_content += """
                </div>
              </div>
            </body>
            </html>
            """
            subject = 'Your SecureView Browsing Report'
        else:
            return {'statusCode': 400, 'body': json.dumps({'message': 'Invalid action'})}

        ses_client.send_email(
            Source=email,
            Destination={'ToAddresses': [email]},
            Message={
                'Subject': {'Data': subject},
                'Body': {'Html': {'Data': html_content}}
            }
        )

        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Email sent successfully'})
        }
    except cognito_client.exceptions.NotAuthorizedException:
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Invalid or expired token'})
        }
    except Exception as e:
        print(f"Email report error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'message': 'An internal error occurred. Please try again later.'})
        }
