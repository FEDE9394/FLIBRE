# -*- coding: utf-8 -*-
import sys
import urllib.parse
import json
from resources.lib.scraper import Scraper, log
from resources.lib import parser
from resources.lib import player
from resources.lib import config

try:
    import xbmcgui
    import xbmcplugin
    import xbmc
    KODI = True
except ImportError:
    KODI = False

# Get plugin handles
addon_handle = int(sys.argv[1]) if len(sys.argv) > 1 else 0
plugin_url = sys.argv[0] if len(sys.argv) > 0 else ""

def display_title(title, max_length=80):
    """Normalize labels so skins can render them cleanly in one row."""
    title = " ".join(str(title or "").split())
    title = "".join(char for char in title if char.isalnum() or char.isspace() or char in "[]().,:/-_+&")
    title = " ".join(title.split())
    if len(title) > max_length:
        title = title[:max_length - 3].rstrip() + "..."
    return title

def build_url(query):
    return plugin_url + '?' + urllib.parse.urlencode(query)

def add_directory_item(title, query, is_folder=True, image="", is_playable=False, fanart=""):
    if not KODI:
        return
    title = display_title(title)
    url = build_url(query)
    listitem = xbmcgui.ListItem(title)
    
    # Configurar arte del elemento (iconos)
    art = {}
    if image:
        art["thumb"] = image
        art["icon"] = image
    if fanart:
        art["fanart"] = fanart
    if art:
        listitem.setArt(art)
    
    if is_playable:
        listitem.setProperty('IsPlayable', 'true')
        listitem.setInfo('video', {
            'title': title,
            'mediatype': 'video'
        })
    else:
        listitem.setInfo('video', {
            'title': title,
            'mediatype': 'video'
        })
    
    xbmcplugin.addDirectoryItem(handle=addon_handle, url=url, listitem=listitem, isFolder=is_folder)

def main_menu():
    log("Loading main menu")
    # Iconos y fanart para el menú principal
    icon_path = "special://home/addons/plugin.video.futbollibre/resources/media/icons/icon.png"
    channels_icon = "special://home/addons/plugin.video.futbollibre/resources/media/icons/channels.png"
    agenda_icon = "special://home/addons/plugin.video.futbollibre/resources/media/icons/agenda.png"
    fanart_path = "special://home/addons/plugin.video.futbollibre/resources/media/fanart/fanart.jpg"
    
    add_directory_item(
        "Canales en vivo",
        {"action": "list_channels"},
        is_folder=True,
        image=channels_icon,
        fanart=fanart_path
    )
    add_directory_item(
        "Agenda de partidos",
        {"action": "list_agenda"},
        is_folder=True,
        image=agenda_icon,
        fanart=fanart_path
    )
    if KODI:
        xbmcplugin.endOfDirectory(addon_handle)

def list_channels():
    log("Loading channels list")
    scraper = Scraper()
    html = scraper.get_html(config.BASE_URL)
    if not html:
        if KODI:
            xbmcgui.Dialog().notification("Error", "No se pudo cargar la web de Fútbol Libre", xbmcgui.NOTIFICATION_ERROR)
            xbmcplugin.endOfDirectory(addon_handle, False)
        return
         
    channels = parser.parse_channels(html)
    fanart_path = "special://home/addons/plugin.video.futbollibre/resources/media/fanart/fanart.jpg"
    default_icon = "special://home/addons/plugin.video.futbollibre/resources/media/icons/channels.png"
    
    for channel in channels:
        # Usar la imagen del canal si está disponible, sino el icono de canales
        channel_image = channel["image"] if channel["image"] else default_icon
        
        add_directory_item(
            title=channel["title"],
            query={"action": "play", "url": channel["url"], "title": channel["title"]},
            is_folder=False,
            image=channel_image,
            is_playable=True,
            fanart=fanart_path
        )
         
    if KODI:
        xbmcplugin.setContent(addon_handle, 'videos')
        xbmcplugin.endOfDirectory(addon_handle)

def list_agenda():
    log("Loading agenda list")
    scraper = Scraper()
    
    # Icono y fanart para la agenda
    agenda_icon = "special://home/addons/plugin.video.futbollibre/resources/media/icons/agenda.png"
    fanart_path = "special://home/addons/plugin.video.futbollibre/resources/media/fanart/fanart.jpg"
     
    # Primary source: agenda rendered in the site's HTML (complete, matches the web)
    html = scraper.get_html(config.BASE_URL)
    events = parser.parse_agenda_html(html) if html else []

    # Fallback: JSON API
    if not events:
        json_text = scraper.get_html(config.AGENDA_URL, referer=config.BASE_URL)
        if json_text:
            events = parser.parse_agenda_json(json_text)

    if not events:
        if KODI:
            xbmcgui.Dialog().notification("Error", "No se pudo cargar la agenda de partidos", xbmcgui.NOTIFICATION_ERROR)
            xbmcplugin.endOfDirectory(addon_handle, False)
        return

    for event in events:
            # We pass the options as a JSON string to list them when selected
            options_json = json.dumps(event["options"])
            add_directory_item(
                title=event["title"],
                query={"action": "list_options", "title": event["title"], "options": options_json},
                is_folder=True,
                image=agenda_icon,
                fanart=fanart_path
            )

    if KODI:
        xbmcplugin.endOfDirectory(addon_handle)

def list_options(title, options_json):
    log(f"Listing options for event: {title}")
    fanart_path = "special://home/addons/plugin.video.futbollibre/resources/media/fanart/fanart.jpg"
    channels_icon = "special://home/addons/plugin.video.futbollibre/resources/media/icons/channels.png"
    
    try:
        options = json.loads(options_json)
    except Exception as e:
        log(f"Error decoding options: {e}")
        options = []
         
    for option in options:
        add_directory_item(
            title=option["title"],
            query={"action": "play", "url": option["url"], "title": f"{title} - {option['title']}"},
            is_folder=False,
            image=channels_icon,
            is_playable=True,
            fanart=fanart_path
        )
         
    if KODI:
        xbmcplugin.setContent(addon_handle, 'videos')
        xbmcplugin.endOfDirectory(addon_handle)

def play_video(url, title):
    log(f"Initiating playback for URL: {url}")
    scraper = Scraper()
    
    # Icono para el diálogo de carga
    icon_path = "special://home/addons/plugin.video.futbollibre/resources/media/icons/icon.png"
     
    if KODI:
        dialog = xbmcgui.DialogProgress()
        dialog.create("⚽ Fútbol Libre", "🎬 Obteniendo enlace de reproducción...")
         
    stream_url, referer = parser.parse_stream_url(scraper, url)
     
    if KODI:
        dialog.close()
         
    if not stream_url:
        log("Failed to resolve streaming URL")
        if KODI:
            xbmcgui.Dialog().ok("❌ Error", "No se encontró el canal o el stream está offline")
            xbmcplugin.endOfDirectory(addon_handle, False)
        return
         
    player.play_stream(addon_handle, stream_url, referer, title)

def router():
    # Parse query parameters from sys.argv
    qs = sys.argv[2].lstrip('?') if len(sys.argv) > 2 else ""
    params = dict(urllib.parse.parse_qsl(qs))
    
    action = params.get("action")
    if not action:
        main_menu()
    elif action == "list_channels":
        list_channels()
    elif action == "list_agenda":
        list_agenda()
    elif action == "list_options":
        list_options(params.get("title", ""), params.get("options", "[]"))
    elif action == "play":
        play_video(params.get("url"), params.get("title", "Streaming"))

if __name__ == "__main__":
    router()
