import os
import logging
import re
import random
import string
import requests
from telegram import Update
from telegram.ext import Updater, CommandHandler, MessageHandler, Filters, CallbackContext
from PIL import Image
import pytesseract
from io import BytesIO
from bs4 import BeautifulSoup

# Enable logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', 
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Get the bot token from environment variable
TOKEN = os.environ.get('BOT_TOKEN')

# Store processed transaction IDs to prevent reuse
processed_transactions = set()

def start(update: Update, context: CallbackContext):
    """Send a message when the command /start is issued."""
    update.message.reply_text(
        'Welcome to CVerve Payment Verifier Bot! '
        'Send me a screenshot of your CBE transaction receipt to verify your payment.'
    )

def help_command(update: Update, context: CallbackContext):
    """Send a message when the command /help is issued."""
    update.message.reply_text(
        'This bot verifies CBE payment receipts. '
        'Send a screenshot of your transaction receipt with a visible URL. '
        'The bot will check if the payment is valid and grant access accordingly.'
    )

def extract_text_from_image(image):
    """Extract text from an image using OCR"""
    return pytesseract.image_to_string(image)

def extract_url(text):
    """Extract URL from text using regex"""
    url_pattern = re.compile(r'https?://\S+')
    match = url_pattern.search(text)
    return match.group() if match else None

def fetch_receipt_content(url):
    """Fetch content from the receipt URL"""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.text
    except requests.RequestException as e:
        logger.error(f"Error fetching URL content: {e}")
        return None

def parse_receipt_content(html_content):
    """Parse receipt content from HTML"""
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # Extract receiver name
    receiver_element = soup.find('td', text=re.compile(r'Receiver', re.IGNORECASE))
    receiver = receiver_element.find_next('td').get_text().strip() if receiver_element else None
    
    # Extract transferred amount
    amount_element = soup.find('td', text=re.compile(r'Transferred Amount', re.IGNORECASE))
    amount_text = amount_element.find_next('td').get_text().strip() if amount_element else None
    amount = float(amount_text.split()[0]) if amount_text else None
    
    # Extract account number
    account_element = soup.find('td', text=re.compile(r'Account', re.IGNORECASE))
    account = account_element.find_next('td').get_text().strip() if account_element else None
    
    # Extract reference number
    reference_element = soup.find('td', text=re.compile(r'Reference No\. \(VAT Invoice No\)', re.IGNORECASE))
    reference = reference_element.find_next('td').get_text().strip() if reference_element else None
    
    return {
        'receiver': receiver,
        'amount': amount,
        'account': account,
        'reference': reference
    }

def generate_alphanumeric_code(length=6):
    """Generate a random alphanumeric code"""
    characters = string.ascii_uppercase + string.digits
    return ''.join(random.choice(characters) for _ in range(length))

def process_screenshot(update: Update, context: CallbackContext):
    """Process the screenshot sent by the user"""
    user = update.message.from_user
    photo_file = update.message.photo[-1].get_file()
    
    # Download the image
    image_data = BytesIO()
    photo_file.download(out=image_data)
    image_data.seek(0)
    
    # Open and process the image
    image = Image.open(image_data)
    
    # Extract text from image using OCR
    extracted_text = extract_text_from_image(image)
    
    # Check if it's a CBE debit receipt
    if "Commercial Bank of Ethiopia" not in extracted_text or "Total amount debited from customers account" not in extracted_text:
        update.message.reply_text("Access not granted: Not a valid CBE debit receipt.")
        return
    
    # Extract URL from the text
    url = extract_url(extracted_text)
    if not url:
        update.message.reply_text("Access not granted: No valid URL found in the receipt.")
        return
    
    # Check if this transaction has been processed before
    transaction_id = url.split('=')[-1] if '=' in url else url
    if transaction_id in processed_transactions:
        update.message.reply_text("Access not granted: This receipt has already been used.")
        return
    
    # Fetch receipt content from the URL
    html_content = fetch_receipt_content(url)
    if not html_content:
        update.message.reply_text("Access not granted: Could not fetch receipt content.")
        return
    
    # Parse receipt content
    receipt_data = parse_receipt_content(html_content)
    
    # Check if all required data is present
    if not all([receipt_data.get('receiver'), receipt_data.get('amount'), 
                receipt_data.get('account'), receipt_data.get('reference')]):
        update.message.reply_text("Access not granted: Could not extract all required information from receipt.")
        return
    
    # Check receiver name
    if receipt_data['receiver'] != "YILAK ABAY ABEBE":
        update.message.reply_text("Access not granted: Receiver name does not match.")
        return
    
    # Check account ends with 7639
    if not receipt_data['account'].endswith('7639'):
        update.message.reply_text("Access not granted: Account does not end with 7639.")
        return
    
    # Check reference number starts with FT
    if not receipt_data['reference'].startswith('FT'):
        update.message.reply_text("Access not granted: Reference number does not start with FT.")
        return
    
    # Check if reference number is in URL
    if receipt_data['reference'] not in url:
        update.message.reply_text("Access not granted: Reference number not found in URL.")
        return
    
    # Check amount and grant access
    amount = receipt_data['amount']
    if 75 <= amount < 145:
        code = generate_alphanumeric_code()
        update.message.reply_text(f"{code} - Basic Level is granted.")
    elif 145 <= amount < 198:
        code = generate_alphanumeric_code()
        update.message.reply_text(f"{code} - Professional Level is granted.")
    elif amount >= 198:
        code = generate_alphanumeric_code()
        update.message.reply_text(f"{code} - Premium Level is granted.")
    else:
        update.message.reply_text("Access not granted: Amount is outside valid ranges.")
        return
    
    # Mark transaction as processed
    processed_transactions.add(transaction_id)

def main():
    """Start the bot."""
    # Set up the Updater
    updater = Updater(TOKEN, use_context=True)

    # Get the dispatcher to register handlers
    dispatcher = updater.dispatcher

    # Register command handlers
    dispatcher.add_handler(CommandHandler("start", start))
    dispatcher.add_handler(CommandHandler("help", help_command))

    # Register message handler for photos
    dispatcher.add_handler(MessageHandler(Filters.photo, process_screenshot))

    # Start the Bot
    updater.start_polling()
    updater.idle()

if __name__ == '__main__':
    main()