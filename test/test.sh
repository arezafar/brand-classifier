#!/bin/sh

BRANDS=( "AOL" "AT&T" "Allstate" "Apple" "BestBuy" "Bionaire" "BoConcept Furniture" "Bose" "Brita Water Filters" "Brother" "COACH" "Cadillac" "Canon" "Constant Contact" "Disney" "Don Julio" "Duxiana" "Electrolux" "Facebook" "Ford" "FreshBooks" "Gigya" "Google" "HP" "Jouer" "Klipsch" "Lincoln" "Loudmouth Golf" "L’Oréal" "Microsoft" "Mini" "Nest" "Nikon" "One Medical Group" "PayPal" "Plantronics" "Porsche" "Quantum" "Samsung Galaxy" "Samsung" "Sonicare" "Southern New Hampshire University" "Sprint" "Square" "The North Face" "Twitter" "U.S. Cellular" "UPS" "Verizon" "Walmart" "Wolf of Wall Street" "inPowered" )
for BRAND in "${BRANDS[@]}"
do
    node test.js --BRAND=$BRAND
done
