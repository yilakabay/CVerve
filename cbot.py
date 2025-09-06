import os
import random
import string
import re
import requests
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

# Get token from environment variable
TOKEN = os.environ.get('8499138063:AAF7yahB4QCaSrpzmZBQqmi_ifYAqtT6m94')

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        'Welcome to CBE Payment Verifier Bot! '
        'Send me a screenshot of your CBE transaction receipt.'
    )

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        await update.message.reply_text("Processing your screenshot...")
        
        # Get the photo file
        photo_file = await update.message.photo[-1].get_file()
        
        # Download the photo
        photo_bytes = await photo_file.download_as_bytearray()
        
        # For Railway deployment, we'll use text recognition from user input
        await update.message.reply_text(
            "Please type the text from your receipt so I can verify it.\n\n"
            "Include:\n"
            "- Receiver name (YILAK ABAY ABEBE)\n"
            "- Account number (ending with 7639)\n"
            "- Amount transferred (at least ETB 75.00)\n"
            "- Any URLs in the receipt"
        )
        
    except Exception as e:
        await update.message.reply_text(f"An error occurred: {str(e)}")

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        text = update.message.text
        
        # Check if this is a valid CBE transaction
        if not is_valid_cbe_transaction(text):
            await update.message.reply_text("This doesn't appear to be a valid CBE transaction receipt.")
            return
            
        # Extract URL from the text
        url = extract_url(text)
        if not url:
            await update.message.reply_text("Could not find a valid URL in the receipt.")
            return
            
        # Verify the transaction details from the URL
        if not verify_transaction_from_url(url):
            await update.message.reply_text("Transaction verification failed. The receipt may not be valid.")
            return
            
        # Extract amount and check if it's at least 75 ETB
        amount = extract_amount(text)
        if amount < 75:
            await update.message.reply_text("Access not granted. Minimum transfer amount is ETB 75.00.")
            return
            
        # Generate 6-digit alphanumeric code
        code = generate_code()
        
        await update.message.reply_text(f"✅ Access granted! Your verification code is: {code}")
        
    except Exception as e:
        await update.message.reply_text(f"An error occurred: {str(e)}")

def is_valid_cbe_transaction(text):
    # Check for CBE indicators
    cbe_indicators = ["CBE", "Commercial Bank of Ethiopia", "Thank you for Banking with CBE"]
    return any(indicator.upper() in text.upper() for indicator in cbe_indicators)

def extract_url(text):
    # Simple URL extraction
    url_pattern = r'https?://[^\s]+'
    urls = re.findall(url_pattern, text)
    return urls[0] if urls else None

def verify_transaction_from_url(url):
    try:
        # Fetch the content from the URL
        response = requests.get(url, timeout=10)
        
        if response.status_code != 200:
            return False
            
        # Check for required elements in the response
        content = response.text
        
        # Check for receiver name
        if "YILAK ABAY ABEBE" not in content.upper():
            return False
            
        # Check for account number ending with 7639
        if not re.search(r'\*{2,}7639', content):
            return False
            
        # Check for CBE branding (approximation of live stamp)
        if "Commercial Bank of Ethiopia" not in content:
            return False
            
        return True
        
    except Exception:
        return False

def extract_amount(text):
    # Try to find amount in the text
    amount_patterns = [
        r'ETB\s*(\d+\.\d{2})',
        r'Transferred Amount\s*(\d+\.\d{2})',
        r'Amount\s*(\d+\.\d{2})'
    ]
    
    for pattern in amount_patterns:
        matches = re.search(pattern, text, re.IGNORECASE)
        if matches:
            return float(matches.group(1))
    
    return 0.0

def generate_code():
    """Generate a 6-digit alphanumeric code"""
    characters = string.ascii_uppercase + string.digits
    return ''.join(random.choice(characters) for _ in range(6))

def main():
    # Create the Application
    application = Application.builder().token(TOKEN).build()
    
    # Add handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    
    # Start the bot
    print("Bot is running...")
    application.run_polling()

if __name__ == '__main__':
    main()