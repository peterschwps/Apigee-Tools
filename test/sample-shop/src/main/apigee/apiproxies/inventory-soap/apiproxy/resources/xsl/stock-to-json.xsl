<?xml version="1.0" encoding="ISO-8859-1"?>
<!-- Wandelt die SOAP-Antwort des Lagerdienstes in schlankes XML für XMLToJSON um -->
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:inv="urn:shop.example:inventory"
    exclude-result-prefixes="soap inv">
    <xsl:output method="xml" encoding="UTF-8" omit-xml-declaration="yes"/>

    <xsl:template match="/">
        <xsl:apply-templates select="soap:Envelope/soap:Body/inv:StockResponse"/>
    </xsl:template>

    <!-- Lagerbestand je Größe und Farbe -->
    <xsl:template match="inv:StockResponse">
        <stock>
            <sku><xsl:value-of select="inv:Sku"/></sku>
            <warehouse><xsl:value-of select="inv:Warehouse"/></warehouse>
            <variants>
                <xsl:for-each select="inv:Item">
                    <variant>
                        <size><xsl:value-of select="inv:Size"/></size>
                        <color><xsl:value-of select="inv:Color"/></color>
                        <quantity><xsl:value-of select="inv:Quantity"/></quantity>
                    </variant>
                </xsl:for-each>
            </variants>
        </stock>
    </xsl:template>
</xsl:stylesheet>
