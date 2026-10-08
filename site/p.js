// /p/<piece>, the share link for one piece, loads this to send people on to that piece in the shop.
// (Link previews come from that page's tags; this only runs in a browser.)
location.replace("/shop.html#p-" + encodeURIComponent(location.pathname.split("/").pop() ?? ""));
